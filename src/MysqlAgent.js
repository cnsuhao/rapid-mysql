var mysql = require('mysql'),
    util = require('util'),
    Q = require('q');


exports = module.exports = MysqlAgent;

function MysqlAgent(options) {
    var resource = options.resource;
    if (resource) {
        var idx = resource.indexOf('.');
        if (idx === -1) { // /database
            options.database = resource;
        } else {
            options.database = resource.substr(0, idx);
            this._tableName = resource.substr(idx + 1);
        }
    }
    if (options.key) {
        this._key = options.key;
    }
    var conf = this._conf = util._extend({}, this._conf);

    for (var keys = Object.keys(conf), n = keys.length; n--;) {
        var key = keys[n];
        if (options.hasOwnProperty(key)) {
            conf[key] = options[key];
        }
    }
    var clusters = conf.clusters, N;
    if (clusters) {
        N = clusters.length;
        clusters.forEach(function (obj) {
            obj.__proto__ = options;
            var forbidCount = obj.forbidCount || 10;
            obj.forbidCount = N === 1 ? 0 : forbidCount / (N - 1);
            obj.forbidden = 0;
            obj.slave = !!obj.slave;
        });
    } else {
        options.forbidden = options.forbidCount = 0;
        options.slave = false;
        N = 1;
    }


    var conns = [], // all free connections
        allowedAgents = conf.maxConnects,
        pending = [], nonSlavePending = [], keepAliveTimer = null, connects = 0;
    this._context = {
        getConnection: function (cb, nonSlave) {
            var L = conns.length;
            if (L) {
                if (nonSlave) {
                    for (var i = L; i-- && conns[i].slave;);
                    if (i + 1) { // found
                        var ret = conns.splice(i, 1)[0];
                        if (i === 0) { // first taken
                            clearTimeout(keepAliveTimer);
                            keepAliveTimer = conns.length ? setTimeout(keepAliveTimeout, conns[0].keepAliveExpires - Date.now()) : null;
                        }
                        return cb(null, ret);
                    }
                } else {
                    if (L === 1) {
                        clearTimeout(keepAliveTimer);
                        keepAliveTimer = null;
                    }
                    return cb(null, conns.pop());
                }
            }
            (nonSlave ? nonSlavePending : pending).push(cb);
            if (allowedAgents) {
                allowedAgents--;
                connect(conf.maxRetries, nonSlave);
            }
        },
        releaseConnection: release
    };

    // 申请新的连接
    function connect(retries, nonSlave) {
        var option;
        if (clusters) {
            for (; ;) {
                option = clusters[connects++ % N];
                if (nonSlave && option.slave) { // ignore
                } else if (option.forbidden) {
                    option.forbidden--;
                } else {
                    break;
                }
            }
        } else {
            option = options;
        }

        var conn = mysql.createConnection(option);
        conn.slave = option.slave;
//        console.log('connecting', retries);
        conn.connect(function (err) {
            if (err) {
//                console.log('connect::' + err.message, retries);
                if (typeof err.code !== 'number') {
                    option.forbidden = option.forbidCount;
                    if (retries) {
                        return setTimeout(connect, clusters ? 0 : conf.retryTimeout, retries - 1);
                    }
                }
                // report error to all pending responses
                var arr = nonSlave ? nonSlavePending : pending;
                arr.forEach(function (cb) {
                    cb(err);
                });
                arr.length = 0;
                allowedAgents++;
            } else { // connected
                conn.expires = Date.now() + conf.keepAliveMaxLife;
                release(conn);
            }
        });
    }

    function release(conn) {
        var t = Date.now();
        if (t > conn.expires) { // connection expired
            end(conn);
        }
        if (!conn.slave && nonSlavePending.length) {
            nonSlavePending.pop()(null, conn);
        } else if (pending.length) {
            pending.pop()(null, conn);
        } else {
            conns.push(conn);
            if (conns.length === 1) {
                keepAliveTimer = setTimeout(keepAliveTimeout, conf.keepAliveTimeout);
            } else {
                conn.keepAliveExpires = t + conf.keepAliveTimeout;
            }
        }
    }

    function end(conn) {
        allowedAgents++;
        try {
            conn.end(nop);
        } catch (e) {
        }
    }

    function keepAliveTimeout() {
        var conn = conns.shift();
        end(conn);
        keepAliveTimer = conns.length ? setTimeout(keepAliveTimeout, conns[0].keepAliveExpires - Date.now()) : null;
    }

    function nop() {
    }

}
var MysqlImpl = require('./MysqlImpl');

MysqlAgent.prototype = {
    __proto__: MysqlImpl.prototype,
    impl: {db: true, storage: true},
    _conf: {
        clusters: null,
        maxConnects: 30,
        keepAliveTimeout: 5000,
        keepAliveMaxLife: 30000,
        retryTimeout: 400,
        maxRetries: 3
    },
    _context: null,
    _tableName: null,
    _key: 'id',
    constructor: exports,
    begin: function (cb) {
        var self = this;
        var oldErr = new Error();
        return promiseCallback(Q.Promise(function (resolve, reject) {
            self._context.getConnection(function (err, conn) {
                if (err) {
                    return reject(makeError(err, oldErr));
                } else {
                    resolve(transaction(self, conn, self));
                }
            }, true);
        }), cb);
    },
    prepare: function (sql, options) {
        options = Object(options);
        options.__proto__ = {useCache: true, cacheTime: 0, serializer: Function.call.bind(Array.prototype.join)};

        if (options.useCache) {
            return makePendingStatement(this, sql, options.serializer, options.cacheTime);
        } else {
            return makeStatement(this, sql);
        }
    }
};


function transaction(agent, conn) {
    conn.query('begin');
    return {
        _context: {
            getConnection: function (cb) {
                cb(null, conn);
            }, releaseConnection: function () {
            }
        },
        _tableName: agent._tableName,
        _key: agent._key,
        __proto__: MysqlImpl.prototype,
        commit: function (cb) {
            return end('commit', cb);
        },
        rollback: function (cb) {
            return end('rollback', cb);
        }
    };
    function end(stmt, cb) {
        var _conn = conn;
        conn = null;
        return promiseCallback(Q.Promise(function (resolve, reject) {
            _conn.query(stmt, function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
                agent._context.releaseConnection(_conn);
            });
        }), cb);
    }
}

function makeStatement(agent, sql) {
    return function (val, cb) {
        if (typeof val === 'function') {
            cb = val;
            val = null;
        }
        return promiseCallback(agent.query(sql, val), cb);
    }
}

function makePendingStatement(agent, sql, serialize, delay) {
    var pending = {};
    return delay ? function (val, cb, noCache) {
        if (typeof val === 'function') { // cb, [noCache]
            noCache = cb;
            cb = val;
            val = null;
        } else if (typeof val !== 'object') { // noCache
            noCache = val;
            val = cb = null;
        } else if (typeof cb !== 'function') { // val, [noCache]
            noCache = cb;
            cb = null;
        }

        var key = val ? serialize(val) : '';

        var ret = pending[key];
        if (ret) {
            if (!ret.expires) { // request not completed yet
                return ret;
            } else if (!noCache) { // use cache
                if (ret.expires < Date.now()) { // expired
                    cleanup();
                } else {
                    return ret;
                }
            }
        }
        // not requested or request not completed or cache expired or nocache

        ret = pending[key] = agent.query(sql, val);
        ret.expires = 0;
        ret.finally(function () {
            ret.expires = Date.now() + delay;
        });
        return promiseCallback(ret, cb);
    } : function (val, cb) {
        if (typeof val === 'function') {
            cb = val;
            val = null;
        }
        var key = val ? serialize(val) : '';

        var ret = pending[key];
        if (ret) {
            return ret;
        }
        // not requested or request not completed or cache expired or nocache

        ret = pending[key] = agent.query(sql, val);
        ret.finally(function () {
            pending[key] = null;
        });
        return promiseCallback(ret, cb);
    };

    function cleanup() {
        var newPending = {}, t = Date.now();
        Object.keys(pending).forEach(function (key) {
            var p = pending[key];
            if (!p.expires || p.expires > t) {
                newPending[key] = p;
            }
        });
        pending = newPending;
    }
}


function promiseCallback(promise, cb) {
    if (cb) {
        promise = promise.then(function (ret) {
            cb(null, ret)
        }, cb);
    }
    return promise;
}

function makeError(err, oldErr) {
    err = new Error(err.message);
    oldErr = oldErr.stack;
    var newStack = err.stack, idx = newStack.indexOf('\n'), idx2 = newStack.indexOf('\n', idx + 1);
    err.stack = newStack.substr(0, idx) + newStack.substr(idx2) +
        '\n========' + oldErr.substr(oldErr.indexOf('\n'));
    return err;
}