import { createDatabaseClient } from './index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL.');
const database = createDatabaseClient(url);
try {
  await database.organization.upsert({
    where: { slug: 'maxbio' },
    update: {},
    create: { name: 'MaxBio', slug: 'maxbio' },
  });
  console.info('Organización MaxBio preparada. No se crearon usuarios ni credenciales.');
} finally {
  await database.$disconnect();
}
