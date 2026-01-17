const { Client } = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');

class OneDriveService {
  constructor() {
    this.tenantId = process.env.MICROSOFT_TENANT_ID;
    this.clientId = process.env.MICROSOFT_CLIENT_ID;
    this.clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
    // For application (service-to-service) auth, we need a specific user's OneDrive
    this.userEmail = process.env.MICROSOFT_USER_EMAIL || 'info@acropaq.com';
    this.graphClient = null;

    if (this.tenantId && this.clientId && this.clientSecret) {
      this.initializeClient();
    } else {
      console.warn('Microsoft Graph credentials not configured. OneDrive uploads will be skipped.');
    }
  }

  /**
   * Get the drive API path - uses specific user for app auth, /me for delegated auth
   */
  getDrivePath() {
    // For application credentials, we must use a specific user's drive
    return `/users/${this.userEmail}/drive`;
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
      const fileStream = fs.createReadStream(localFilePath);
      const fileStats = fs.statSync(localFilePath);
      
      let uploadedFile;
      
      if (fileStats.size < 4 * 1024 * 1024) {
        // Small file upload (< 4MB)
        uploadedFile = await this.graphClient
          .api(`${this.getDrivePath()}/root:${remotePath}:/content`)
          .put(fileStream);
      } else {
        // Large file upload session
        uploadedFile = await this.uploadLargeFile(remotePath, fileStream, fileStats.size);
      }
      
      // Create sharing link
      const sharingLink = await this.graphClient
        .api(`${this.getDrivePath()}/items/${uploadedFile.id}/createLink`)
        .post({
          type: 'view',
          scope: 'organization' // Only people in your organization can access
        });
      
      console.log(`Recording uploaded to OneDrive: ${fileName}`);
      
      return {
        url: sharingLink.link.webUrl,
        fileId: uploadedFile.id
      };
      
    } catch (error) {
      console.error('OneDrive upload failed:', error);
      throw error;
    }
  }
  
  /**
   * Ensure folder structure exists in OneDrive
   */
  async ensureFolderExists(folderPath) {
    const parts = folderPath.split('/').filter(p => p);
    let currentPath = '';
    
    for (const part of parts) {
      currentPath += `/${part}`;
      try {
        await this.graphClient.api(`${this.getDrivePath()}/root:${currentPath}`).get();
      } catch (error) {
        if (error.code === 'itemNotFound') {
          // Create folder
          const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
          await this.graphClient
            .api(`${this.getDrivePath()}/root:${parentPath}:/children`)
            .post({
              name: part,
              folder: {},
              '@microsoft.graph.conflictBehavior': 'rename'
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
    const uploadSession = await this.graphClient
      .api(`${this.getDrivePath()}/root:${remotePath}:/createUploadSession`)
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
   * Test connection to Microsoft Graph
   */
  async testConnection() {
    if (!this.graphClient) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      // For app auth, test by accessing the user's drive instead of /me
      const drive = await this.graphClient.api(this.getDrivePath()).get();
      return {
        success: true,
        drive: {
          name: drive.name,
          owner: drive.owner?.user?.displayName || this.userEmail,
          webUrl: drive.webUrl
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new OneDriveService();