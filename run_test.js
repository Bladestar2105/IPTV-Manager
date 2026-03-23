import db from './src/database/db.js';
import { getPlaylist } from './src/controllers/xtreamController.js';

const mockReq = {
  query: { username: 'testuser', password: 'testpassword' },
  get: () => 'localhost:3000',
  protocol: 'http',
  app: { get: () => false },
  params: {}
};

const mockRes = {
  setHeader: () => {},
  write: (data) => console.log('WRITING:', data),
  end: () => console.log('ENDED'),
  sendStatus: (code) => console.log('STATUS:', code)
};

getPlaylist(mockReq, mockRes);
