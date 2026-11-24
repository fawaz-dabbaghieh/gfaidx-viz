// The server's indexed graphs, one .tar each (the graph and its index files),
// in a public S3 bucket that allows anonymous listing from any origin.
export const BUCKET = 'steineggerlab'
export const PREFIX = 'gfaidx/'
export const BUCKET_URL = `https://${BUCKET}.s3.amazonaws.com`
export const BUCKET_PATH = `s3://${BUCKET}/${PREFIX}`
