const { Storage } = require('@google-cloud/storage');

const bucketName = () => process.env.GCS_BUCKET?.trim() || '';
const publicBase = () => process.env.GCS_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || '';

const isEnabled = () => Boolean(bucketName());

let storageClient;

const client = () => {
  if (!storageClient) storageClient = new Storage();
  return storageClient;
};

const extForMime = (mimeType) => {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
};

const storageKeyFor = (businessId, photoId, mimeType) =>
  `businesses/${businessId}/photos/${photoId}.${extForMime(mimeType)}`;

const publicUrlForKey = (storageKey) => {
  const base = publicBase();
  if (!base) return null;
  return `${base}/${storageKey}`;
};

/** Photo URL — use API_PUBLIC_BASE_URL in production so browsers load from Cloud Run directly. */
const apiPhotoPath = (businessId, photoId) => {
  const path = `/public/businesses/${businessId}/photos/${photoId}`;
  const base = process.env.API_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (base) return `${base}${path}`;
  return `/api/public/businesses/${businessId}/photos/${photoId}`;
};

const uploadBusinessPhoto = async (businessId, photoId, buffer, mimeType) => {
  const storageKey = storageKeyFor(businessId, photoId, mimeType);

  if (!isEnabled()) {
    return { storageKey: null, url: apiPhotoPath(businessId, photoId) };
  }

  const file = client().bucket(bucketName()).file(storageKey);
  await file.save(buffer, {
    metadata: {
      contentType: mimeType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    resumable: buffer.length > 5 * 1024 * 1024,
  });

  return {
    storageKey,
    url: publicUrlForKey(storageKey) || apiPhotoPath(businessId, photoId),
  };
};

const deleteBusinessPhoto = async (storageKey) => {
  if (!isEnabled() || !storageKey) return;
  try {
    await client().bucket(bucketName()).file(storageKey).delete({ ignoreNotFound: true });
  } catch {
    /* best-effort cleanup */
  }
};

const openBusinessPhotoReadStream = (storageKey) => {
  if (!isEnabled() || !storageKey) return null;
  return client().bucket(bucketName()).file(storageKey).createReadStream();
};

module.exports = {
  isEnabled,
  apiPhotoPath,
  uploadBusinessPhoto,
  deleteBusinessPhoto,
  openBusinessPhotoReadStream,
};
