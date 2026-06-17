const Business = require('../models/Business');
const photoStorage = require('./photoStorage.service');

const PHOTO_CACHE = 'public, max-age=31536000, immutable';

const streamPhoto = async (businessId, photoId, res) => {
  const photo = await Business.findSetupPhoto(businessId, photoId);
  if (!photo) {
    res.status(404).json({ message: 'photo not found' });
    return;
  }

  if (photo.storageKey) {
    const stream = photoStorage.openBusinessPhotoReadStream(photo.storageKey);
    if (stream) {
      res.set('Content-Type', photo.mimeType || 'image/jpeg');
      res.set('Cache-Control', PHOTO_CACHE);
      stream.on('error', () => {
        if (!res.headersSent) res.status(404).json({ message: 'photo not found' });
      });
      stream.pipe(res);
      return;
    }
  }

  if (photo.data) {
    const body = Buffer.from(photo.data, 'base64');
    res.set('Content-Type', photo.mimeType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(body);
    return;
  }

  const externalUrl = photo.url?.startsWith('http') ? photo.url : null;
  if (externalUrl && !externalUrl.includes(`/public/businesses/${businessId}/photos/${photoId}`)) {
    res.set('Cache-Control', PHOTO_CACHE);
    res.redirect(302, externalUrl);
    return;
  }

  res.status(404).json({ message: 'photo not found' });
};

module.exports = { streamPhoto };
