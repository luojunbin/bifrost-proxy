/* eslint-disable consistent-return */
/* eslint-disable no-underscore-dangle */
/* eslint-disable func-names */
/* eslint-disable no-param-reassign */
/* eslint-disable prefer-destructuring */
const http = require('http');
const https = require('https');
const { parse: urlParse } = require('url');
const util = require('util');
const net = require('net');
const tls = require('tls');
const assert = require('assert');
const { getAgent } = require('./util');

const { ClientRequest, request: origRequest } = http;
const HOST_RE = /^\s*[\w.-]+\s*$/;
const CONNECT_RE = /^\s*connect\s*$/i;
let globalProxy;

const checkHost = (host) => HOST_RE.test(host);
const checkPort = (port) => port > 0 && port <= 65535;

const formatProxy = (proxy) => {
  if (!proxy || typeof proxy === 'function') {
    return proxy;
  }
  const {
    host, port, headers, filterRequest,
  } = proxy;
  assert(checkHost(host), 'Enter the correct host.');
  assert(checkPort(port), 'Enter the correct port.');
  return {
    host,
    port,
    headers,
    filterRequest,
  };
};

const getProxy = (options, isHttps) => {
  if (!options || !globalProxy || typeof globalProxy !== 'function') {
    return globalProxy;
  }
  const proxy = formatProxy(globalProxy(Object.keys({}, options)));
  if (proxy) {
    proxy.headers = proxy.headers || {};
    if (!proxy.headers.host) {
      let { host } = options;
      if (typeof host === 'string') {
        host = host.split(':', 1)[0];
        if (host) {
          proxy.headers.host = `${host}:${options.port || (isHttps ? 443 : 80)}`;
        }
      }
    }
  }
  return proxy;
};

const checkMethod = (opts) => opts && CONNECT_RE.test(opts.method);

function ClientRequestProxy(uri, options, cb, isHttps) {
  if (typeof uri === 'string') {
    uri = urlParse(uri);
  }
  if (typeof options === 'function') {
    cb = options;
    options = uri;
  } else {
    options = {
      ...uri,
      ...options,
    };
  }
  if (isHttps) {
    options._defaultAgent = https.globalAgent;
  }
  if (globalProxy && !checkMethod(uri) && !checkMethod(options)) {
    const proxy = getProxy(options, isHttps);
    const enableProxy = () => {
      const filterEnable = !proxy.filterRequest || proxy.filterRequest(options);
      const headerEnable = !options.headers || !options.headers['x-bifrost-disable-proxy'];
      return filterEnable && headerEnable;
    };
    if (proxy && enableProxy()) {
      proxy.isHttps = isHttps;
      options.agent = getAgent(proxy, options);
      if (!options.headers) {
        options.headers = {};
      }
      options.headers = {
        ...proxy.headers,
        ...options.headers,
      };
    }
    // 清理proxy特殊请求头
    delete options.headers.host;
  }
  ClientRequest.call(this, options, cb);
}

util.inherits(ClientRequestProxy, ClientRequest);

http.ClientRequest = ClientRequestProxy;
http.request = function (url, options, cb) {
  return new ClientRequestProxy(url, options, cb);
};
http.get = function get(url, options, cb) {
  const req = new ClientRequestProxy(url, options, cb);
  req.end();
  return req;
};

https.request = function (url, options, cb) {
  return new ClientRequestProxy(url, options, cb, true);
};
https.get = function get(url, options, cb) {
  const req = new ClientRequestProxy(url, options, cb, true);
  req.end();
  return req;
};

exports.setProxy = (proxy) => {
  globalProxy = formatProxy(proxy);
  return globalProxy;
};

exports.proxy = exports.setProxy;

exports.getProxy = getProxy;

exports.removeProxy = () => {
  globalProxy = null;
};

const createConnection = (options) => {
  const proxy = getProxy(options);
  if (!proxy || (proxy.filterRequest && !proxy.filterRequest(options))) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(options, () => resolve(socket));
      socket.on('error', reject);
    });
  }

  const headers = options.headers || {};
  const path = `${options.host}:${options.port}`;
  headers.host = path;
  headers['x-whistle-policy'] = 'tunnel';
  const proxyOpts = {
    method: 'CONNECT',
    agent: false,
    host: proxy.host,
    port: proxy.port,
    path,
    headers,
  };
  return new Promise((resolve, reject) => {
    const req = origRequest(proxyOpts);
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        return reject(
          new Error(`Tunneling socket could not be established, statusCode=${res.statusCode}`),
        );
      }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
};

exports.createConnection = createConnection;

exports.createTlsConnection = (options) => createConnection(options).then((socket) => tls.connect({
  socket,
  rejectUnauthorized: false,
  servername: options.servername || options.host,
}));
