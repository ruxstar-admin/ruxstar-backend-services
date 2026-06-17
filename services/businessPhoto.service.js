const Business = require('../models/Business');
const photoStorage = require('./photoStorage.service');

const PHOTO_CACHE = 'public, max-age=31536000, immutable';

const findLivePhoto = async (businessId, photoId) => {
  if (!photoId) return null;
  const business = await Business.findLiveById(businessId, { withPhotoData: true });
  if (!business?.setup?.photos) return null;
  return business.setup.photos.find((p) => p.id === photoId) ?? null;
};

const streamPhoto = async (businessId, photoId, res) => {
  const photo = await findLivePhoto(businessId, photoId);
  if (!photo) {
    res.status(404).json({ message: 'photo not found' });
    return;
  }

  if (photo.url?.startsWith('http')) {
    res.set('Cache-Control', PHOTO_CACHE);
    res.redirect(302, photo.url);
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

  res.status(404).json({ message: 'photo not found' });
};

module.exports = { streamPhoto, findLivePhoto };
