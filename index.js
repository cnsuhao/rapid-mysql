var MysqlAgent = require('./src/MysqlAgent');
exports.instance = function (options) {
    return new MysqlAgent(options);
};
