// storage.js — File upload to S3 / Cloudflare R2 + presigned URL generation
// Works with any S3-compatible storage (AWS S3, Cloudflare R2, MinIO)

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");
const crypto = require("crypto");

// Detect which storage is configured
function createS3Client() {
  // Cloudflare R2
  if (process.env.R2_ACCOUNT_ID) {
    return new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  // AWS S3
  if (process.env.AWS_ACCESS_KEY_ID) {
    return new S3Client({
      region: process.env.AWS_REGION || "ap-south-1",
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return null;
}

const s3     = createS3Client();
const BUCKET = process.env.S3_BUCKET || process.env.R2_BUCKET || "mom-tool";

function isStorageConfigured() { return !!s3; }

// Upload a file buffer — returns { key, url }
async function uploadFile({ buffer, originalName, mimeType, userId }) {
  if (!s3) throw new Error("Storage not configured. Add S3 or R2 credentials to .env");

  const ext  = path.extname(originalName).toLowerCase();
  const key  = `uploads/${userId}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
    Metadata:    { originalName, userId: String(userId) },
  }));

  console.log(`[Storage] ✅ Uploaded: ${key} (${(buffer.length/1024/1024).toFixed(2)} MB)`);
  return { key };
}

// Generate a presigned URL valid for N seconds (default 1 hour)
async function getPresignedUrl(key, expiresIn = 3600) {
  if (!s3) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

// Delete a file from storage
async function deleteFile(key) {
  if (!s3 || !key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  console.log(`[Storage] Deleted: ${key}`);
}

module.exports = { isStorageConfigured, uploadFile, getPresignedUrl, deleteFile };