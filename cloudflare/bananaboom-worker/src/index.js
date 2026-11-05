import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app.js';

const app = createApp();
await app.ready();
export default httpServerHandler(createServer(app.callback()));
