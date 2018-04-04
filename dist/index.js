"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tv4 = require("tv4");
const mustache = require("mustache");
const rp = require("request-promise-native");
const _debug = require("debug");
const commands_1 = require("./commands");
const debug = _debug('node-vault');
const defaults = (obj, vals) => Object.assign(obj, vals, obj);
const merge = (obj, vals) => Object.assign({}, obj, vals);
exports.default = (config = {}) => {
    // load conditional dependencies
    const depends = {
        debug: config.debug || debug,
        tv4: config.tv4 || tv4,
        commands: config.commands || commands_1.default,
        mustache: config.mustache || mustache,
        rp: (config['request-promise'] || rp).defaults({
            json: true,
            resolveWithFullResponse: true,
            simple: false,
            strictSSL: !process.env.VAULT_SKIP_VERIFY,
        })
    };
    const hasErrors = body => body && body.errors && body.errors.length > 0;
    const trace = (name, fn) => {
        return (path, ...args) => {
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
        request: (options = {}) => {
            options = options.inherit === false ? options : Object.assign({}, config.requestOptions, options);
            delete options.inherit;
            const valid = depends.tv4.validate(options, requestSchema);
            if (!valid)
                return Promise.reject(depends.tv4.error);
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
        help: trace('help', (path, options) => client.request(merge(options, {
            path: `/${path}?help=1`,
            method: 'GET',
        }))),
        write: trace('write', (path, data, options) => client.request(merge(options, {
            path: `/${path}`,
            json: data,
            method: 'PUT',
        }))),
        read: trace('read', (path, options) => client.request(merge(options, {
            path: `/${path}`,
            method: 'GET',
        }))),
        list: trace('list', (path, options) => client.request(merge(options, {
            path: `/${path}`,
            method: 'LIST',
        }))),
        delete: trace('delete', (path, options) => client.request(merge(options, {
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
        if (!schema)
            return Promise.resolve(options);
        const params = [];
        for (const key of Object.keys(schema.properties)) {
            if (key in options.json) {
                params.push(`${key}=${encodeURIComponent(options.json[key])}`);
            }
        }
        options.path += params.length ? `?${params.join('&')}` : '';
        return Promise.resolve(options);
    }
    client.generateFunction = (confs) => (name, conf = null) => {
        const config = (conf && conf.method && conf.path && conf) || confs[name];
        // console.log(`Loading ${name} config`, config);
        client[name] = (args = {}) => {
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
    Object.keys(commands_1.default).forEach(client.generateFunction(commands_1.default));
    return client;
};
//# sourceMappingURL=index.js.map