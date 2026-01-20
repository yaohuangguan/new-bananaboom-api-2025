import connectDB from '../config/db.js';
import Resume from '../models/Resume.js';

const verify = async () => {
    try {
        await connectDB();
        const sam = await Resume.findOne({ slug: 'sam' });
        if (sam) {
            console.log('--- Sam Resume Locations ---');
            sam.work.forEach(w => {
                console.log(`Company: ${w.company_en}, LocEN: ${w.location_en}, LocZH: ${w.location_zh}`);
            });
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};
verify();
