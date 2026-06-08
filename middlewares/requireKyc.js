const User = require('../models/User');

module.exports = async (req, res, next) => {
  const user = await User.findById(req.user.id);
  const kycStatus = user?.vendorProfile?.kyc?.status;
  if (kycStatus !== 'verified') {
    return res.status(403).json({ message: 'kyc_required', kycStatus: kycStatus || 'pending' });
  }
  next();
};
