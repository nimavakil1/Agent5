const { Client } = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');

class OneDriveService {
  constructor() {
    this.tenantId = process.env.MICROSOFT_TENANT_ID;
    this.clientId = process.env.MICROSOFT_CLIENT_ID;
    this.clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
    // SharePoint site configuration
    this.sharePointHost = process.env.SHAREPOINT_HOST || 'acropaq2.sharepoint.com';
    this.sharePointSite = process.env.SHAREPOINT_SITE || 'Acropaq-AITest';
    this.graphClient = null;
    this.siteId = null;

    if (this.tenantId && this.clientId && this.clientSecret) {
      this.initializeClient();
    } else {
      console.warn('Microsoft Graph credentials not configured. OneDrive uploads will be skipped.');
    }
  }

  /**
   * Get the SharePoint site ID (cached)
   */
  async getSiteId() {
    if (this.siteId) return this.siteId;

    const site = await this.graphClient
      .api(`/sites/${this.sharePointHost}:/sites/${this.sharePointSite}`)
      .get();
    this.siteId = site.id;
    return this.siteId;
  }

  /**
   * Get the drive API path - uses SharePoint site's document library
   */
  async getDrivePath() {
    const siteId = await this.getSiteId();
    return `/sites/${siteId}/drive`;
  }
  
  initializeClient() {
    try {
      const credential = new ClientSecretCredential(
        this.tenantId,
        this.clientId,
        this.clientSecret
      );
      
      this.graphClient = Client.initWithMiddleware({
        authProvider: {
          getAccessToken: async () => {
            const tokenResponse = await credential.getToken(['https://graph.microsoft.com/.default']);
            return tokenResponse.token;
          }
        }
      });
      
      console.log('Microsoft Graph client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Microsoft Graph client:', error);
      this.graphClient = null;
    }
  }
  
  /**
   * Upload recording file to OneDrive organized by date
   * @param {string} localFilePath - Path to local recording file
   * @param {string} callId - Call identifier
   * @param {Date} callDate - Date of the call
   * @returns {Promise<{url: string, fileId: string}>}
   */
  async uploadRecording(localFilePath, callId, callDate = new Date()) {
    if (!this.graphClient) {
      throw new Error('Microsoft Graph client not initialized');
    }
    
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`Local file not found: ${localFilePath}`);
    }
    
    try {
      // Create folder structure: /Agent5-Recordings/YYYY/MM/DD/
      const year = callDate.getFullYear();
      const month = String(callDate.getMonth() + 1).padStart(2, '0');
      const day = String(callDate.getDate()).padStart(2, '0');
      
      const folderPath = `/Agent5-Recordings/${year}/${month}/${day}`;
      await this.ensureFolderExists(folderPath);
      
      // Generate filename with timestamp
      const timestamp = callDate.toISOString().replace(/[:.]/g, '-');
      const fileExtension = path.extname(localFilePath);
      const fileName = `${callId}_${timestamp}${fileExtension}`;
      const remotePath = `${folderPath}/${fileName}`;
      
      // Upload file
      const fileStats = fs.statSync(localFilePath);
      const drivePath = await this.getDrivePath();

      let uploadedFile;

      if (fileStats.size < 4 * 1024 * 1024) {
        // Small file upload (< 4MB) - use buffer for SharePoint compatibility
        const fileBuffer = fs.readFileSync(localFilePath);
        uploadedFile = await this.graphClient
          .api(`${drivePath}/root:${remotePath}:/content`)
          .put(fileBuffer);
      } else {
        // Large file upload session
        const fileStream = fs.createReadStream(localFilePath);
        uploadedFile = await this.uploadLargeFile(remotePath, fileStream, fileStats.size);
      }

      // Create sharing link
      const sharingLink = await this.graphClient
        .api(`${drivePath}/items/${uploadedFile.id}/createLink`)
        .post({
          type: 'view',
          scope: 'organization' // Only people in your organization can access
        });
      
      console.log(`Recording uploaded to SharePoint: ${fileName}`);
      
      return {
        url: sharingLink.link.webUrl,
        fileId: uploadedFile.id
      };
      
    } catch (error) {
      console.error('SharePoint upload failed:', error);
      throw error;
    }
  }
  
  /**
   * Ensure folder structure exists in SharePoint
   */
  async ensureFolderExists(folderPath) {
    const drivePath = await this.getDrivePath();
    const parts = folderPath.split('/').filter(p => p);
    let currentPath = '';

    for (const part of parts) {
      currentPath += `/${part}`;
      try {
        // Check if folder exists using /root:/path format
        await this.graphClient.api(`${drivePath}/root:${currentPath}`).get();
      } catch (error) {
        if (error.statusCode === 404 || error.code === 'itemNotFound') {
          // Create folder - use /root/children for root level, or /root:/parentPath:/children for nested
          const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
          const apiPath = parentPath
            ? `${drivePath}/root:${parentPath}:/children`
            : `${drivePath}/root/children`;

          await this.graphClient
            .api(apiPath)
            .post({
              name: part,
              folder: {},
              '@microsoft.graph.conflictBehavior': 'replace'
            });
        } else {
          throw error;
        }
      }
    }
  }
  
  /**
   * Upload large files using upload session
   */
  async uploadLargeFile(remotePath, fileStream, fileSize) {
    const drivePath = await this.getDrivePath();
    const uploadSession = await this.graphClient
      .api(`${drivePath}/root:${remotePath}:/createUploadSession`)
      .post({});
    
    // Upload in chunks (4MB each)
    const chunkSize = 4 * 1024 * 1024;
    let uploadedBytes = 0;
    const chunks = [];
    
    // Read file in chunks
    return new Promise((resolve, reject) => {
      fileStream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      fileStream.on('end', async () => {
        try {
          const fullBuffer = Buffer.concat(chunks);
          
          for (let i = 0; i < fullBuffer.length; i += chunkSize) {
            const chunk = fullBuffer.slice(i, i + chunkSize);
            const rangeStart = i;
            const rangeEnd = i + chunk.length - 1;
            
            const response = await this.graphClient
              .api(uploadSession.uploadUrl)
              .headers({
                'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${fileSize}`,
                'Content-Length': chunk.length
              })
              .put(chunk);
              
            uploadedBytes += chunk.length;
            console.log(`Uploaded ${uploadedBytes}/${fileSize} bytes`);
            
            if (response.id) {
              // Upload complete
              resolve(response);
              return;
            }
          }
        } catch (error) {
          reject(error);
        }
      });
      
      fileStream.on('error', reject);
    });
  }
  
  /**
   * Test connection to Microsoft Graph / SharePoint
   */
  async testConnection() {
    if (!this.graphClient) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      // Test by accessing the SharePoint site's document library
      const drivePath = await this.getDrivePath();
      const drive = await this.graphClient.api(drivePath).get();
      return {
        success: true,
        sharePoint: {
          site: this.sharePointSite,
          driveName: drive.name,
          webUrl: drive.webUrl
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new OneDriveService();