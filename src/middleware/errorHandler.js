import multer from 'multer';

export const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err.type === 'entity.too.large') { // Body parser limit
      return res.status(413).json({ error: 'Payload too large' });
  }

  // Default to 500
  res.status(500).json({ error: err.message || 'Internal Server Error' });
};
