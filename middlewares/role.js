module.exports = (...roles) => (req, res, next) => {
  const userRoles = req.user?.roles ?? [];
  if (!roles.some((r) => userRoles.includes(r)))
    return res.status(403).json({ message: 'forbidden' });
  next();
};
