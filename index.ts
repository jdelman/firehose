import { startServer } from './src/server/index.ts';

const server = startServer();

console.log(`Server listening on http://localhost:${server.port}`);
