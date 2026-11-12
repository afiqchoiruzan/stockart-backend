const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const useAtlas = process.env.USE_ATLAS !== 'false';
        const targetUri = useAtlas
            ? (process.env.MONGO_URI_ATLAS || process.env.MONGO_URI)
            : (process.env.MONGO_URI_LOCAL || 'mongodb://127.0.0.1:27017/stockart_db');

        const conn = await mongoose.connect(targetUri);
        const targetLabel = useAtlas ? 'MongoDB Atlas (Cloud)' : 'MongoDB Lokal (127.0.0.1:27017)';
        console.log(`MongoDB Connected: ${conn.connection.host} [${targetLabel}]`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;