'use strict';
// supergateway 4.1.0 has no --host flag and listens on every interface of the
// container, so any other container on the same Docker network could talk to it
// and skip the authenticating proxy. This file is loaded with `node --require`
// (via NODE_OPTIONS, see entrypoint.sh) and makes one specific port listen on
// 127.0.0.1 only. All other ports are left alone.
//
// FORCE_LOOPBACK_PORT  the port to pin to loopback (nothing happens if unset)

const net = require('net');

const PORT = parseInt(process.env.FORCE_LOOPBACK_PORT || '', 10);

if (Number.isInteger(PORT) && PORT > 0) {
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(...args) {
    const first = args[0];
    if ((typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) && Number(first) === PORT) {
      // listen(port[, host][, backlog][, callback])
      if (typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
    } else if (first && typeof first === 'object' && Number(first.port) === PORT && !first.host) {
      // listen(options[, callback])
      args[0] = Object.assign({}, first, { host: '127.0.0.1' });
    }
    return original.apply(this, args);
  };
}
