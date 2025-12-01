const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI  || require('./keys').mongoURI


const connectDB = async () => await mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));


module.exports = connectDB;