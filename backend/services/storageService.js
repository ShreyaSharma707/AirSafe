import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const bucket = process.env.AWS_S3_BUCKET;
const client = bucket ? new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' }) : null;

export async function persistSnapshot(snapshot) {
  if (!client) return;
  const key = `snapshots/${snapshot.refreshedAt.replace(/[:.]/g, '-')}.json`;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: 'application/json',
    Body: JSON.stringify(snapshot)
  }));
  console.log(`Stored historical snapshot in s3://${bucket}/${key}`);
}
