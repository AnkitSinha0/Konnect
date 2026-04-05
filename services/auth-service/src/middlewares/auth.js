const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
      return res.status(401).json({ message: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        console.error('JWT verification error:', err.message);
        return res.status(403).json({ message: 'Invalid or expired token' });
      }
      
      console.log('JWT decoded payload:', decoded);
      
      // Handle both old and new token formats for backward compatibility
      req.userId = decoded.userId || decoded.id;
      req.userEmail = decoded.email;
      
      if (!req.userId) {
        console.error('No user ID found in token payload:', decoded);
        return res.status(403).json({ message: 'Invalid token payload' });
      }
      
      console.log('Auth middleware setting userId:', req.userId);
      next();
    });
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { authenticateToken };