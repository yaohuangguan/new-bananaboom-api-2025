const mongoose = require("mongoose");
//start redis server
const redis = require("redis");
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const client = redis.createClient(redisUrl);
const utils = require("util");
//get exec erference of mongo
const exec = mongoose.Query.prototype.exec;
//promise the client get function
client.get = utils.promisify(client.get);

//check if we need to cache
mongoose.Query.prototype.cache = function() {
  this.useCache = true;

  return this;
};

//rewrite exec
mongoose.Query.prototype.exec = async function() {
  if (!this.useCache) {
    return exec.apply(this, arguments);
  }
  console.log("using cache");
  const query = this.getQuery();
  const key = JSON.stringify(
    Object.assign({}, query, {
      collection: this.mongooseCollection.name
    })
  );

  const cachedValue = await client.get(key);
  if (cachedValue) {
    const doc = JSON.parse(cachedValue);
    const arrCheck = Array.isArray(doc)
      ? doc.map(each => new this.model(each))
      : new this.model(doc);

    return arrCheck;
  }
  const result = await exec.apply(this, arguments);
  client.set(key, JSON.stringify(result), "EX", 300);
  return result;
};
const clearHash = (key) => {
  client.del(JSON.stringify(key))
}
module.exports = client;