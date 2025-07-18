# xfetch

This is a little experiment I made a while ago to automate my browser over WebSockets—without using the Chrome DevTools protocol.

## What's here

- `xfetch.js`: Main logic for sending/queuing fetch requests via WebSocket. Handles reconnects, cookies, and retries.
- `socket-server.js`: WebSocket server for the above.
- `chrome-extension/`: Chrome extension that works with xfetch. Lets you do stuff in the browser (see `manifest.json` for permissions).

## Usage

- Run the server (`socket-server.js`) and use `xfetch.js` in your Node app to talk to it.
- The Chrome extension needs to be loaded as an unpacked extension in Chrome.

## Notes

- The extension asks for a lot of permissions (`cookies`, `proxy`, etc.), so heads up.
- Not really production-ready, but handy for experiments or internal tools. 