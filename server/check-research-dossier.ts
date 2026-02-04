/**
 * Script to check research dossier status for a conversation
 * Usage: npx ts-node check-research-dossier.ts "Latest test IP"
 */

// Load environment variables
require('dotenv').config();

import pg from './src/db/pg-query';

async function checkResearchDossier(topic: string) {
  try {
    const query = `
      SELECT 
        c.zid,
        c.topic,
        ci.conversation_id,
        CASE 
          WHEN c.research_dossier IS NULL THEN 'NULL'
          WHEN LENGTH(c.research_dossier) = 0 THEN 'EMPTY'
          ELSE 'HAS_CONTENT'
        END as dossier_content_status,
        c.research_dossier_status,
        c.research_dossier_generated_at,
        c.research_dossier_error,
        LENGTH(c.research_dossier) as dossier_length
      FROM conversations c
      LEFT JOIN conversation_ids ci ON c.zid = ci.zid
      WHERE c.topic = $1
    `;
    
    const results = (await pg.queryP(query, [topic])) as any[];
    
    if (!results || results.length === 0) {
      console.log(`❌ No conversation found with topic "${topic}"`);
      return;
    }
    
    const conv = results[0];
    console.log(`\n📊 Research Dossier Status for "${topic}":`);
    console.log('================================================');
    console.log(`ZID: ${conv.zid}`);
    console.log(`Conversation ID: ${conv.conversation_id || 'N/A'}`);
    console.log(`Topic: ${conv.topic}`);
    console.log(`\nDossier Content: ${conv.dossier_content_status}`);
    console.log(`Dossier Status: ${conv.research_dossier_status || 'NULL'}`);
    console.log(`Dossier Length: ${conv.dossier_length || 0} characters`);
    
    if (conv.research_dossier_generated_at) {
      const date = new Date(Number(conv.research_dossier_generated_at));
      console.log(`Generated At: ${date.toISOString()}`);
    } else {
      console.log(`Generated At: Never`);
    }
    
    if (conv.research_dossier_error) {
      console.log(`\n⚠️  Error: ${conv.research_dossier_error}`);
    }
    
    if (conv.dossier_content_status === 'HAS_CONTENT') {
      console.log('\n✅ Learning pack exists in database!');
    } else {
      console.log('\n❌ No learning pack content found in database');
    }
    
    process.exit(0);
  } catch (error: any) {
    console.error('Error checking research dossier:', error);
    process.exit(1);
  }
}

const topic = process.argv[2] || 'Latest test IP';
checkResearchDossier(topic);

