module.exports = (req, res, next) => {
  const { secretToken } = req.body;
  if (!secretToken) {
    return res.status(401).json("You are not vip");
  }
  return next();
};
