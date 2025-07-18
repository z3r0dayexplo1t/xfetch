const Xfetch = require('./xfetch');

const xfetch = new Xfetch('ws://localhost:3006');

xfetch.fetch('https://www.google.com').then(console.log).catch(console.error);