import * as tv4 from 'tv4';
import * as mustache from 'mustache';
import * as rp from 'request-promise-native';
import * as _debug from 'debug';
import commands from './commands';

const debug = _debug('node-vault');
const defaults = (obj, vals) => Object.assign(obj, vals, obj);
const merge = (obj, vals) => Object.assign({}, obj, vals);

export type VaultConfig = {
  debug?: any;
  tv4?: any;
  commands?: any;
  mustache?: any;
  'request-promise'?: any;
  apiVersion?: string;
  endpoint?: string;
  token?: string;
  requestOptions?: { [key: string]: any };
}

export type VaultRequestConfig = {
  uri: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'LIST';
  headers: { [key: string]: string };
  json: { [key: string]: string | number };
};

export type VaultRequestOptions = Partial<VaultRequestConfig>;

export default (config: VaultConfig = {}) => {
  // load conditional dependencies
  const depends = {
    debug: config.debug || debug,
    tv4: config.tv4 || tv4,
    commands: config.commands || commands,
    mustache: config.mustache || mustache,
    rp: (config['request-promise'] || rp).defaults({
      json: true,
      resolveWithFullResponse: true,
      simple: false,
      strictSSL: !process.env.VAULT_SKIP_VERIFY,
    })
  };

  const hasErrors = body => body && body.errors && body.errors.length > 0;

  const trace = <T>(name: string, fn: (path: string, ...args: any[]) => T): (...args: any[]) => T => {
    return (path: string, ...args: any[]) => {
      depends.debug(name === 'write' ? `write: ${path}: ${JSON.stringify(args[0])}` : `${name}: ${path}`);
      return fn(path, ...args);
    };
  };

  const client = {
    apiVersion: config.apiVersion || 'v1',
    endpoint: config.endpoint || process.env.VAULT_ADDR || 'http://127.0.0.1:8200',
    token: config.token || process.env.VAULT_TOKEN,

    handleVaultResponse: (response) => {
      if (!response) {
        return Promise.reject(new Error('No response passed'));
      }
      const { statusCode, body, request } = response;
      depends.debug(statusCode);

      if ([200, 204].includes(statusCode)) {
        return Promise.resolve(body);
      }

      // handle health response not as error
      return (request.path.match(/sys\/health/) !== null)
        ? Promise.resolve(body)
        : Promise.reject(new Error(hasErrors(body) ? body.errors[0] : `Status ${statusCode}`));
    },

    /**
     * Handle any HTTP requests
     */
    request: (options: VaultRequestOptions & { inherit?: boolean } = {}) => {
      options = options.inherit === false ? options : Object.assign({}, config.requestOptions, options);
      delete options.inherit;

      const valid = depends.tv4.validate(options, requestSchema);
      if (!valid) return Promise.reject(depends.tv4.error);

      const uriTpl = `${client.endpoint}/${client.apiVersion}${options.path}`;

      options = defaults(options, {
        // Replace variables in URI, replace unicode encodings
        uri: mustache.render(uriTpl, options.json).replace(/&#x2F;/g, '/'),
        headers: {},
      });

      if (typeof client.token === 'string' && client.token && options.headers) {
        options.headers['X-Vault-Token'] = client.token;
      }
      depends.debug(options.method, options.uri);
      return rp(options).then(client.handleVaultResponse);
    },

    help: trace('help', (path: string, options: VaultRequestOptions) => client.request(merge(options, {
      path: `/${path}?help=1`,
      method: 'GET',
    }))),

    write: trace('write', (path: string, data, options: VaultRequestOptions) => client.request(merge(options, {
      path: `/${path}`,
      json: data,
      method: 'PUT',
    }))),

    read: trace('read', (path: string, options: VaultRequestOptions) => client.request(merge(options, {
      path: `/${path}`,
      method: 'GET',
    }))),

    list: trace('list', (path: string, options: VaultRequestOptions) => client.request(merge(options, {
      path: `/${path}`,
      method: 'LIST',
    }))),

    delete: trace('delete', (path: string, options: VaultRequestOptions) => client.request(merge(options, {
      path: `/${path}`,
      method: 'DELETE',
    })))
  };

  const requestSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
      },
      method: {
        type: 'string',
      },
    },
    required: ['path', 'method'],
  };

  function validate(json, schema) {
    // Ignore validation if no schema
    if (schema === undefined || depends.tv4.validate(json, schema)) {
      return Promise.resolve();
    }
    depends.debug(depends.tv4.error.dataPath);
    depends.debug(depends.tv4.error.message);
    return Promise.reject(depends.tv4.error);
  }

  function extendOptions(conf, options) {
    const schema = conf.schema.query;
    // no schema for the query -> no need to extend
    if (!schema) return Promise.resolve(options);
    const params: string[] = [];
    for (const key of Object.keys(schema.properties)) {
      if (key in options.json) {
        params.push(`${key}=${encodeURIComponent(options.json[key])}`);
      }
    }
    options.path += params.length ? `?${params.join('&')}` : '';
    return Promise.resolve(options);
  }

  client.generateFunction = (confs: typeof commands) => (name: string, conf: any = null) => {
    const config = (conf && conf.method && conf.path && conf) || confs[name];

    // console.log(`Loading ${name} config`, config);

    client[name] = (args: any = {}) => {
      const options = Object.assign({}, config.requestOptions, args.requestOptions, {
        method: config.method,
        path: config.path,
        json: args,
      });

      // No schema object -> no validation, else, do validation of request URL and body
      return !config.schema
        ? client.request(options)
        : validate(options.json, config.schema.req)
            .then(() => validate(options.json, config.schema.query))
            .then(() => extendOptions(config, options))
            .then(client.request);
    };
  };

  Object.keys(commands).forEach(client.generateFunction(commands));

  return client;
};
