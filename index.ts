import { startServer } from './src/server/index.ts';

const server = startServer();

console.log(`Server listening on http://${server.hostname}:${server.port}`);
