const fs = require('fs')
const path = require('path')
const { BlobServiceClient } = require('@azure/storage-blob')

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'geopackage'
const blobName = process.env.AZURE_STORAGE_BLOB || 'urban_twin.gpkg'
const localDbPath = path.join(__dirname, '..', 'data', 'urban_twin.gpkg')

let blobClient = null

if (connectionString) {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString)
    const containerClient = blobServiceClient.getContainerClient(containerName)
    blobClient = containerClient.getBlockBlobClient(blobName)
    console.log(`[Azure Storage] Configured for container: "${containerName}", blob: "${blobName}"`)
  } catch (error) {
    console.error('[Azure Storage] Initialization failed:', error.message)
  }
} else {
  console.log('[Azure Storage] AZURE_STORAGE_CONNECTION_STRING is not set. Running in local file-only mode.')
}

/**
 * Downloads the GeoPackage database from Azure Blob Storage to local filesystem.
 * Returns true if successful, false if it fell back to local storage.
 */
async function downloadDatabaseFromBlob() {
  if (!blobClient) {
    console.log('[Azure Storage] No blob configuration. Using existing local GeoPackage.')
    return false
  }

  try {
    console.log('[Azure Storage] Downloading latest GeoPackage from Azure Blob Storage...')
    // Make sure container exists
    const containerClient = blobClient.containerClient
    const exists = await containerClient.exists()
    if (!exists) {
      console.log(`[Azure Storage] Container "${containerName}" does not exist yet. Using local GeoPackage.`)
      return false
    }

    const blobExists = await blobClient.exists()
    if (!blobExists) {
      console.log(`[Azure Storage] Blob "${blobName}" not found in container. Sowing local copy to remote next sync.`)
      return false
    }

    // Ensure data directory exists
    const dir = path.dirname(localDbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Download to a temporary file first, then swap to avoid corrupting a running app
    const tempPath = `${localDbPath}.tmp`
    await blobClient.downloadToFile(tempPath)
    
    if (fs.existsSync(localDbPath)) {
      fs.unlinkSync(localDbPath)
    }
    fs.renameSync(tempPath, localDbPath)
    console.log('✅ [Azure Storage] Successfully downloaded urban_twin.gpkg from cloud storage.')
    return true
  } catch (error) {
    console.error('❌ [Azure Storage] Download failed, falling back to local file:', error.message)
    return false
  }
}

// Debounce timer for uploads
let uploadTimeout = null

/**
 * Schedules an upload of the local GeoPackage back to Azure Blob Storage,
 * debounced to avoid overloading the API on rapid database modifications.
 */
function scheduleDatabaseUpload() {
  if (!blobClient) return

  if (uploadTimeout) {
    clearTimeout(uploadTimeout)
  }

  // Debounce by 12 seconds to bundle rapid simulation updates
  uploadTimeout = setTimeout(async () => {
    try {
      console.log('[Azure Storage] Uploading updated GeoPackage to Azure Blob Storage...')
      
      const containerClient = blobClient.containerClient
      const containerExists = await containerClient.exists()
      if (!containerExists) {
        await containerClient.create({ access: 'container' })
        console.log(`[Azure Storage] Created missing container: "${containerName}"`)
      }

      await blobClient.uploadFile(localDbPath)
      console.log('✅ [Azure Storage] Successfully uploaded local updates to Azure Blob Storage.')
    } catch (error) {
      console.error('❌ [Azure Storage] Periodic upload failed:', error.message)
    }
  }, 12000)
}

module.exports = {
  downloadDatabaseFromBlob,
  scheduleDatabaseUpload,
  isAzureConfigured: () => !!blobClient
}
