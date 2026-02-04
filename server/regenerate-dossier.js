// Quick script to regenerate research dossier
const pg = require('./dist/src/db/pg-query').default;
const { getResearchDossierService } = require('./dist/src/services/researchDossierService');

async function regenerate(zinvite) {
  try {
    console.log('Finding conversation with zinvite:', zinvite);
    const result = await pg.queryP('SELECT zid FROM zinvites WHERE zinvite = $1', [zinvite]);
    
    if (!result.rows || result.rows.length === 0) {
      console.error('Conversation not found for zinvite:', zinvite);
      process.exit(1);
    }
    
    const zid = result.rows[0].zid;
    console.log('Found ZID:', zid);
    console.log('Triggering regeneration...');
    
    const service = getResearchDossierService();
    await service.regenerateForConversation(zid);
    
    console.log('Regeneration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

const zinvite = process.argv[2] || '2rbzyeavfx';
regenerate(zinvite);

