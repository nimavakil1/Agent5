/**
 * SharePoint Intelligence Agent
 *
 * Monitors and analyzes SharePoint activity:
 * - Document uploads, modifications, deletions
 * - File content analysis
 * - Permission changes
 * - Site activity tracking
 * - Collaboration patterns
 *
 * Capabilities:
 * - Real-time document monitoring
 * - Content extraction and analysis
 * - Version tracking
 * - Access pattern analysis
 * - Compliance checking
 * - Document search and retrieval
 *
 * Requires Microsoft Graph API with Application permissions:
 * - Sites.Read.All (read all sites)
 * - Files.Read.All (read all files)
 * - Sites.ReadWrite.All (for file operations)
 *
 * @module SharePointAgent
 */

const { LLMAgent } = require('../LLMAgent');

/**
 * Document types
 */
const DocumentType = {
  CONTRACT: 'contract',
  INVOICE: 'invoice',
  PROPOSAL: 'proposal',
  REPORT: 'report',
  POLICY: 'policy',
  MEETING_NOTES: 'meeting_notes',
  PRESENTATION: 'presentation',
  SPREADSHEET: 'spreadsheet',
  OTHER: 'other'
};

/**
 * Activity types
 */
const ActivityType = {
  CREATED: 'created',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  SHARED: 'shared',
  ACCESSED: 'accessed',
  PERMISSION_CHANGED: 'permission_changed'
};

class SharePointAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'SharePoint Intelligence Agent',
      role: 'sharepoint_intelligence',
      capabilities: [
        'document_monitoring',
        'content_analysis',
        'file_search',
        'activity_tracking',
        'version_tracking',
        'compliance_checking'
      ],
      ...config
    });

    // Microsoft Graph config
    this.graphConfig = {
      tenantId: config.tenantId || process.env.MICROSOFT_TENANT_ID,
      clientId: config.clientId || process.env.MICROSOFT_CLIENT_ID,
      clientSecret: config.clientSecret || process.env.MICROSOFT_CLIENT_SECRET
    };

    // Access token management
    this.accessToken = null;
    this.tokenExpiry = null;

    // Monitoring state
    this.monitoredSites = new Map();  // siteId -> { lastSync, deltaToken }
    this.recentActivity = [];

    // Settings
    this.settings = {
      syncIntervalMs: config.syncIntervalMs || 300000,  // 5 minutes
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024,  // 10MB for content analysis
      monitoredExtensions: config.monitoredExtensions || [
        '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.txt', '.md'
      ]
    };

    // Define tools
    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      {
        name: 'list_sites',
        description: 'List all SharePoint sites in the organization',
        parameters: {
          type: 'object',
          properties: {
            search: {
              type: 'string',
              description: 'Optional search query'
            }
          }
        },
        handler: this._listSites.bind(this)
      },
      {
        name: 'get_site_contents',
        description: 'Get files and folders from a SharePoint site',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'SharePoint site ID'
            },
            folder_path: {
              type: 'string',
              description: 'Optional folder path within the site',
              default: '/'
            }
          },
          required: ['site_id']
        },
        handler: this._getSiteContents.bind(this)
      },
      {
        name: 'get_recent_activity',
        description: 'Get recent file activity across all SharePoint sites',
        parameters: {
          type: 'object',
          properties: {
            hours_back: {
              type: 'number',
              description: 'How many hours back to look',
              default: 24
            },
            activity_type: {
              type: 'string',
              enum: ['created', 'modified', 'deleted', 'all'],
              default: 'all'
            }
          }
        },
        handler: this._getRecentActivity.bind(this)
      },
      {
        name: 'get_file_details',
        description: 'Get detailed information about a specific file',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'SharePoint site ID'
            },
            item_id: {
              type: 'string',
              description: 'File/item ID'
            }
          },
          required: ['site_id', 'item_id']
        },
        handler: this._getFileDetails.bind(this)
      },
      {
        name: 'get_file_content',
        description: 'Get the content of a text-based file for analysis',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'SharePoint site ID'
            },
            item_id: {
              type: 'string',
              description: 'File/item ID'
            }
          },
          required: ['site_id', 'item_id']
        },
        handler: this._getFileContent.bind(this)
      },
      {
        name: 'analyze_document',
        description: 'Analyze a document for type, content summary, and key information',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'SharePoint site ID'
            },
            item_id: {
              type: 'string',
              description: 'File/item ID'
            }
          },
          required: ['site_id', 'item_id']
        },
        handler: this._analyzeDocument.bind(this)
      },
      {
        name: 'search_files',
        description: 'Search for files across all SharePoint sites',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query'
            },
            file_type: {
              type: 'string',
              description: 'Filter by file extension (e.g., docx, pdf)'
            }
          },
          required: ['query']
        },
        handler: this._searchFiles.bind(this)
      },
      {
        name: 'get_file_versions',
        description: 'Get version history of a file',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'SharePoint site ID'
            },
            item_id: {
              type: 'string',
              description: 'File/item ID'
            }
          },
          required: ['site_id', 'item_id']
        },
        handler: this._getFileVersions.bind(this)
      },
      {
        name: 'get_file_permissions',
        description: 'Get sharing/permission information for a file',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'SharePoint site ID'
            },
            item_id: {
              type: 'string',
              description: 'File/item ID'
            }
          },
          required: ['site_id', 'item_id']
        },
        handler: this._getFilePermissions.bind(this)
      },
      {
        name: 'get_user_activity',
        description: 'Get SharePoint activity for a specific user',
        parameters: {
          type: 'object',
          properties: {
            user_id: {
              type: 'string',
              description: 'User ID or email'
            },
            days_back: {
              type: 'number',
              default: 7
            }
          },
          required: ['user_id']
        },
        handler: this._getUserActivity.bind(this)
      },
      {
        name: 'get_shared_externally',
        description: 'Find files shared with external users',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'Optional: limit to specific site'
            }
          }
        },
        handler: this._getSharedExternally.bind(this)
      },
      {
        name: 'get_document_summary',
        description: 'Get a summary of all documents across sites',
        parameters: {
          type: 'object',
          properties: {
            group_by: {
              type: 'string',
              enum: ['site', 'type', 'author', 'date'],
              default: 'site'
            }
          }
        },
        handler: this._getDocumentSummary.bind(this)
      },
      {
        name: 'find_contracts',
        description: 'Find and analyze contract documents',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['all', 'expiring_soon', 'expired'],
              default: 'all'
            }
          }
        },
        handler: this._findContracts.bind(this)
      },
      {
        name: 'detect_sensitive_content',
        description: 'Scan for potentially sensitive content in documents',
        parameters: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'Optional: limit to specific site'
            }
          }
        },
        handler: this._detectSensitiveContent.bind(this)
      }
    ];
  }

  // ==================== AUTHENTICATION ====================

  async _getAccessToken() {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    const fetch = (await import('node-fetch')).default;

    const tokenUrl = `https://login.microsoftonline.com/${this.graphConfig.tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: this.graphConfig.clientId,
      client_secret: this.graphConfig.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${await response.text()}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 300) * 1000);

    return this.accessToken;
  }

  async _graphRequest(endpoint, options = {}) {
    const fetch = (await import('node-fetch')).default;
    const token = await this._getAccessToken();

    const url = endpoint.startsWith('http')
      ? endpoint
      : `https://graph.microsoft.com/v1.0${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Graph API error: ${response.status} - ${await response.text()}`);
    }

    // Handle non-JSON responses (file downloads)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return response.json();
    }

    return response.text();
  }

  // ==================== SITE MANAGEMENT ====================

  async _listSites(params = {}) {
    const { search } = params;

    let endpoint = '/sites?$select=id,name,displayName,webUrl,createdDateTime';

    if (search) {
      endpoint = `/sites?search=${encodeURIComponent(search)}&$select=id,name,displayName,webUrl,createdDateTime`;
    }

    const result = await this._graphRequest(endpoint);

    return {
      sites: result.value.map(site => ({
        id: site.id,
        name: site.name,
        displayName: site.displayName,
        webUrl: site.webUrl,
        createdAt: site.createdDateTime
      })),
      count: result.value.length
    };
  }

  async _getSiteContents(params) {
    const { site_id, folder_path = '/' } = params;

    let endpoint;
    if (folder_path === '/') {
      endpoint = `/sites/${site_id}/drive/root/children?$select=id,name,file,folder,size,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,webUrl`;
    } else {
      endpoint = `/sites/${site_id}/drive/root:${folder_path}:/children?$select=id,name,file,folder,size,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,webUrl`;
    }

    const result = await this._graphRequest(endpoint);

    return {
      siteId: site_id,
      path: folder_path,
      items: result.value.map(item => ({
        id: item.id,
        name: item.name,
        type: item.folder ? 'folder' : 'file',
        size: item.size,
        mimeType: item.file?.mimeType,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
        createdBy: item.createdBy?.user?.displayName,
        modifiedBy: item.lastModifiedBy?.user?.displayName,
        webUrl: item.webUrl
      })),
      count: result.value.length
    };
  }

  // ==================== FILE OPERATIONS ====================

  async _getFileDetails(params) {
    const { site_id, item_id } = params;

    const endpoint = `/sites/${site_id}/drive/items/${item_id}?$expand=permissions`;
    const item = await this._graphRequest(endpoint);

    return {
      id: item.id,
      name: item.name,
      type: item.folder ? 'folder' : 'file',
      size: item.size,
      mimeType: item.file?.mimeType,
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
      createdBy: item.createdBy?.user?.displayName,
      modifiedBy: item.lastModifiedBy?.user?.displayName,
      webUrl: item.webUrl,
      downloadUrl: item['@microsoft.graph.downloadUrl'],
      parentPath: item.parentReference?.path,
      permissions: item.permissions?.map(p => ({
        id: p.id,
        roles: p.roles,
        grantedTo: p.grantedTo?.user?.displayName || p.grantedToIdentities?.[0]?.user?.displayName,
        link: p.link?.type
      }))
    };
  }

  async _getFileContent(params) {
    const { site_id, item_id } = params;

    // First get file details to check size and type
    const details = await this._getFileDetails({ site_id, item_id });

    if (details.size > this.settings.maxFileSize) {
      return {
        error: 'File too large for content analysis',
        fileName: details.name,
        size: details.size
      };
    }

    // Check if it's a text-based file
    const textMimeTypes = [
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/json',
      'application/xml'
    ];

    if (!textMimeTypes.some(t => details.mimeType?.includes(t))) {
      // For Office documents, we can't read directly - return metadata
      return {
        fileName: details.name,
        mimeType: details.mimeType,
        message: 'Binary file - content preview not available. Use analyze_document for AI analysis.',
        size: details.size
      };
    }

    // Download text content
    const endpoint = `/sites/${site_id}/drive/items/${item_id}/content`;
    const content = await this._graphRequest(endpoint);

    return {
      fileName: details.name,
      mimeType: details.mimeType,
      size: details.size,
      content: content.substring(0, 50000)  // Limit content size
    };
  }

  async _analyzeDocument(params) {
    const { site_id, item_id } = params;

    const details = await this._getFileDetails({ site_id, item_id });

    // Try to get content or preview
    let contentPreview = '';

    try {
      const content = await this._getFileContent({ site_id, item_id });
      contentPreview = content.content || '';
    } catch (_e) {
      // Binary file - use filename and metadata for analysis
      contentPreview = `[Binary file: ${details.name}]`;
    }

    // Analyze with LLM
    const analysisPrompt = `Analyze this document and provide structured information:

File Name: ${details.name}
Type: ${details.mimeType || 'Unknown'}
Created: ${details.createdAt}
Modified: ${details.modifiedAt}
Author: ${details.createdBy}
Content Preview: ${contentPreview.substring(0, 3000)}

Provide analysis in JSON format:
{
  "documentType": "contract|invoice|proposal|report|policy|meeting_notes|presentation|spreadsheet|other",
  "summary": "2-3 sentence summary of the document",
  "keyInformation": {
    "dates": ["any important dates mentioned"],
    "amounts": ["any monetary amounts"],
    "parties": ["organizations or people mentioned"],
    "actionItems": ["any action items or tasks"]
  },
  "tags": ["relevant tags for categorization"],
  "confidentialityLevel": "public|internal|confidential|highly_confidential",
  "requiresReview": true/false,
  "reviewReason": "why it needs review, if applicable"
}`;

    const analysis = await this._analyzeWithLLM(analysisPrompt);

    return {
      fileId: item_id,
      fileName: details.name,
      siteId: site_id,
      details,
      analysis
    };
  }

  async _analyzeWithLLM(prompt) {
    try {
      const response = await this.llmClient.chat.completions.create({
        model: this.config.model || 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a document analysis assistant. Always respond with valid JSON.'
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      return { error: error.message };
    }
  }

  // ==================== SEARCH ====================

  async _searchFiles(params) {
    const { query, file_type } = params;

    let searchQuery = query;
    if (file_type) {
      searchQuery += ` filetype:${file_type}`;
    }

    const endpoint = `/search/query`;
    const body = {
      requests: [
        {
          entityTypes: ['driveItem'],
          query: { queryString: searchQuery },
          from: 0,
          size: 50
        }
      ]
    };

    const result = await this._graphRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const hits = result.value?.[0]?.hitsContainers?.[0]?.hits || [];

    return {
      query,
      fileType: file_type,
      results: hits.map(hit => ({
        id: hit.resource?.id,
        name: hit.resource?.name,
        webUrl: hit.resource?.webUrl,
        summary: hit.summary,
        lastModified: hit.resource?.lastModifiedDateTime,
        createdBy: hit.resource?.createdBy?.user?.displayName
      })),
      count: hits.length
    };
  }

  // ==================== VERSION HISTORY ====================

  async _getFileVersions(params) {
    const { site_id, item_id } = params;

    const endpoint = `/sites/${site_id}/drive/items/${item_id}/versions`;
    const result = await this._graphRequest(endpoint);

    return {
      itemId: item_id,
      versions: result.value.map(v => ({
        id: v.id,
        lastModifiedAt: v.lastModifiedDateTime,
        modifiedBy: v.lastModifiedBy?.user?.displayName,
        size: v.size
      })),
      count: result.value.length
    };
  }

  // ==================== PERMISSIONS ====================

  async _getFilePermissions(params) {
    const { site_id, item_id } = params;

    const endpoint = `/sites/${site_id}/drive/items/${item_id}/permissions`;
    const result = await this._graphRequest(endpoint);

    return {
      itemId: item_id,
      permissions: result.value.map(p => ({
        id: p.id,
        roles: p.roles,
        grantedTo: p.grantedTo?.user?.displayName || p.grantedToIdentities?.[0]?.user?.displayName,
        email: p.grantedTo?.user?.email || p.grantedToIdentities?.[0]?.user?.email,
        linkType: p.link?.type,
        linkScope: p.link?.scope,
        expirationDateTime: p.expirationDateTime
      })),
      count: result.value.length
    };
  }

  // ==================== ACTIVITY TRACKING ====================

  async _getRecentActivity(params = {}) {
    const { hours_back = 24, activity_type = 'all' } = params;

    // Get all sites
    const sites = await this._listSites();
    const allActivity = [];

    const cutoffDate = new Date(Date.now() - hours_back * 60 * 60 * 1000);

    for (const site of sites.sites) {
      try {
        // Get recent items from each site's drive
        const endpoint = `/sites/${site.id}/drive/root/delta`;
        const result = await this._graphRequest(endpoint);

        for (const item of result.value) {
          const modifiedDate = new Date(item.lastModifiedDateTime);
          if (modifiedDate >= cutoffDate) {
            const activity = {
              siteId: site.id,
              siteName: site.displayName,
              itemId: item.id,
              itemName: item.name,
              type: item.deleted ? 'deleted' : (item.createdDateTime === item.lastModifiedDateTime ? 'created' : 'modified'),
              timestamp: item.lastModifiedDateTime,
              user: item.lastModifiedBy?.user?.displayName,
              webUrl: item.webUrl
            };

            if (activity_type === 'all' || activity_type === activity.type) {
              allActivity.push(activity);
            }
          }
        }
      } catch (error) {
        console.error(`Error getting activity for site ${site.id}: ${error.message}`);
      }
    }

    // Sort by timestamp
    allActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      period: `${hours_back} hours`,
      activityType: activity_type,
      activities: allActivity,
      count: allActivity.length
    };
  }

  async _getUserActivity(params) {
    const { user_id, days_back = 7 } = params;

    // This would ideally use audit logs, but for now we search for files modified by user
    const activity = await this._getRecentActivity({ hours_back: days_back * 24 });

    const userActivity = activity.activities.filter(a =>
      a.user?.toLowerCase().includes(user_id.toLowerCase())
    );

    return {
      userId: user_id,
      period: `${days_back} days`,
      activities: userActivity,
      count: userActivity.length
    };
  }

  // ==================== COMPLIANCE ====================

  async _getSharedExternally(params = {}) {
    const { site_id } = params;

    const sites = site_id
      ? [{ id: site_id }]
      : (await this._listSites()).sites;

    const externallyShared = [];

    for (const site of sites) {
      try {
        const contents = await this._getSiteContents({ site_id: site.id });

        for (const item of contents.items) {
          if (item.type === 'file') {
            const permissions = await this._getFilePermissions({
              site_id: site.id,
              item_id: item.id
            });

            const externalPerms = permissions.permissions.filter(p =>
              p.linkScope === 'anonymous' ||
              p.linkType === 'view' ||
              (p.email && !p.email.includes('@yourdomain.com'))  // Adjust domain
            );

            if (externalPerms.length > 0) {
              externallyShared.push({
                siteId: site.id,
                itemId: item.id,
                name: item.name,
                webUrl: item.webUrl,
                externalPermissions: externalPerms
              });
            }
          }
        }
      } catch (error) {
        console.error(`Error checking site ${site.id}: ${error.message}`);
      }
    }

    return {
      externallySharedFiles: externallyShared,
      count: externallyShared.length,
      warning: externallyShared.length > 0 ? 'Files found with external sharing' : null
    };
  }

  async _detectSensitiveContent(params = {}) {
    const { site_id: _site_id } = params;

    const activity = await this._getRecentActivity({ hours_back: 168 });  // Last week
    const sensitiveFiles = [];

    // Check recent files for sensitive content indicators
    for (const item of activity.activities.slice(0, 30)) {
      try {
        const analysis = await this._analyzeDocument({
          site_id: item.siteId,
          item_id: item.itemId
        });

        if (analysis.analysis?.confidentialityLevel === 'highly_confidential' ||
            analysis.analysis?.requiresReview) {
          sensitiveFiles.push({
            ...item,
            confidentialityLevel: analysis.analysis.confidentialityLevel,
            reviewReason: analysis.analysis.reviewReason
          });
        }
      } catch (error) {
        // Skip files we can't analyze
      }
    }

    return {
      sensitiveFiles,
      count: sensitiveFiles.length
    };
  }

  // ==================== DOCUMENT SUMMARY ====================

  async _getDocumentSummary(params = {}) {
    const { group_by = 'site' } = params;

    const sites = await this._listSites();
    const summary = {
      totalSites: sites.count,
      totalFiles: 0,
      byGroup: {}
    };

    for (const site of sites.sites) {
      try {
        const contents = await this._getSiteContents({ site_id: site.id });
        const fileCount = contents.items.filter(i => i.type === 'file').length;
        summary.totalFiles += fileCount;

        if (group_by === 'site') {
          summary.byGroup[site.displayName] = {
            fileCount,
            items: contents.items.slice(0, 10)  // First 10 items
          };
        }
      } catch (error) {
        console.error(`Error summarizing site ${site.id}: ${error.message}`);
      }
    }

    return summary;
  }

  async _findContracts(params = {}) {
    const { status = 'all' } = params;

    // Search for contract-like documents
    const searchResults = await this._searchFiles({
      query: 'contract OR agreement OR NDA OR terms'
    });

    const contracts = [];

    for (const result of searchResults.results.slice(0, 20)) {
      try {
        // We'd need site_id to analyze - this is a limitation
        contracts.push({
          name: result.name,
          webUrl: result.webUrl,
          lastModified: result.lastModified,
          createdBy: result.createdBy
        });
      } catch (_error) {
        // Skip
      }
    }

    return {
      status,
      contracts,
      count: contracts.length
    };
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();

    try {
      await this._getAccessToken();
      console.log('SharePoint Agent: Microsoft Graph API connected');
    } catch (error) {
      console.warn('SharePoint Agent: Graph API not configured:', error.message);
    }
  }
}

module.exports = {
  SharePointAgent,
  DocumentType,
  ActivityType
};
