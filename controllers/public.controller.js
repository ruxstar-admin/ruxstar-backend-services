const bookingService = require('../services/booking.service');
const businessPhotoService = require('../services/businessPhoto.service');
const productService = require('../services/product.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getBusiness = handle(async (req, res) => {
  const business = await bookingService.getPublicBusiness(req.params.id);
  res.json({ business });
});

exports.listBusinesses = handle(async (_req, res) => {
  const payload = await bookingService.listPublicBusinesses();
  res.json(payload);
});

exports.listSlots = handle(async (req, res) => {
  const payload = await bookingService.listPublicSlots(req.params.id, req.query);
  res.json(payload);
});

exports.getPhoto = async (req, res) => {
  try {
    await businessPhotoService.streamPhoto(req.params.id, req.params.photoId, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }
};

exports.getProductPhoto = async (req, res) => {
  try {
    const photo = await productService.getProductPhoto(req.params.productId, req.params.photoId);
    if (!photo) return res.status(404).json({ message: 'photo not found' });
    res.setHeader('Content-Type', photo.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (photo.stream) return photo.stream.pipe(res);
    return res.send(photo.buffer);
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }
};
