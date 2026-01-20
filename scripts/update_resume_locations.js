import connectDB from '../config/db.js';
import Resume from '../models/Resume.js';
import mongoose from 'mongoose';

const updateLocations = async () => {
    try {
        await connectDB();

        const resumes = await Resume.find({});
        console.log(`Found ${resumes.length} resumes.`);

        for (const resume of resumes) {
            let updated = false;
            if (resume.work && resume.work.length > 0) {
                resume.work.forEach(job => {
                    const company = (job.company_en || job.company_zh || '').toLowerCase();

                    if (company.includes('beehex')) {
                        job.location_en = 'Columbus, USA';
                        job.location_zh = '哥伦布, 美国';
                        console.log(`Updated ${job.company_en} location to Columbus, USA`);
                    } else {
                        job.location_en = 'Shenzhen, China';
                        job.location_zh = '深圳, 中国';
                        console.log(`Updated ${job.company_en} location to Shenzhen, China`);
                    }
                });
                updated = true;
            }

            if (updated) {
                await resume.save();
                console.log(`Saved resume: ${resume.slug}`);
            }
        }

        console.log('All resumes updated.');
        process.exit(0);
    } catch (error) {
        console.error('Error updating resumes:', error);
        process.exit(1);
    }
};

updateLocations();
