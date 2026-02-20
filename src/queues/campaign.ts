/**
 * Wihda Backend - Campaign Ingestion Queue Consumer
 * Handles scheduled campaign ingestion and expiration
 */

import type { Env, CampaignQueueMessage } from '../types';
import { createOrUpdateCampaign, expireOldCampaigns } from '../lib/db';
import { toISODateString } from '../lib/utils';

/**
 * Sample campaign data sources
 * In production, this would fetch from real external APIs or scrape websites
 */
const CAMPAIGN_SOURCES = {
  // Municipal API
  'municipal_api': {
    fetch: async (_neighborhoodId: string): Promise<IngestCampaign[]> => {
      // Simulated API response
      return [
        {
          title: 'Fête de Quartier',
          description: 'Journée festive pour tous les habitants du quartier',
          organizer: 'Municipalité',
          location: 'Place centrale',
          start_dt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          end_dt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000).toISOString(),
          url: 'https://municipality.example/events/fete-quartier',
          external_id: 'municipal-001'
        }
      ];
    }
  },
  
  // NGO/Association feed
  'ngo_feed': {
    fetch: async (_neighborhoodId: string): Promise<IngestCampaign[]> => {
      return [
        {
          title: 'Distribution Alimentaire',
          description: 'Distribution de produits alimentaires pour les familles dans le besoin',
          organizer: 'Association Solidarité',
          location: 'Centre Social',
          start_dt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          url: 'https://ngo.example/events/food-dist',
          external_id: 'ngo-002'
        }
      ];
    }
  },
  
  // Facebook events (simulated)
  'facebook_events': {
    fetch: async (_neighborhoodId: string): Promise<IngestCampaign[]> => {
      return [
        {
          title: 'Atelier de Jardinage Urbain',
          description: 'Apprenez à créer un jardin sur votre balcon',
          organizer: 'Green City Club',
          location: 'Bibliothèque Municipale',
          start_dt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          end_dt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000).toISOString(),
          url: 'https://facebook.com/events/123456',
          external_id: 'fb-003'
        }
      ];
    }
  }
};

interface IngestCampaign {
  title: string;
  description?: string;
  organizer?: string;
  location?: string;
  start_dt: string;
  end_dt?: string;
  url?: string;
  image_url?: string;
  external_id?: string;
}

/**
 * Ingest campaigns from a specific source
 */
async function ingestFromSource(
  env: Env,
  source: string,
  neighborhoodId: string
): Promise<number> {
  const sourceConfig = CAMPAIGN_SOURCES[source as keyof typeof CAMPAIGN_SOURCES];
  
  if (!sourceConfig) {
    console.error(`Unknown source: ${source}`);
    return 0;
  }
  
  try {
    const campaigns = await sourceConfig.fetch(neighborhoodId);
    let ingested = 0;
    
    for (const campaign of campaigns) {
      try {
        await createOrUpdateCampaign(env.DB, {
          neighborhoodId,
          title: campaign.title,
          description: campaign.description,
          organizer: campaign.organizer,
          location: campaign.location,
          startDt: campaign.start_dt,
          endDt: campaign.end_dt,
          url: campaign.url,
          source,
          sourceIdentifier: campaign.external_id
        });
        ingested++;
      } catch (error) {
        console.error(`Failed to ingest campaign: ${campaign.title}`, error);
      }
    }
    
    return ingested;
  } catch (error) {
    console.error(`Failed to fetch from source ${source}:`, error);
    return 0;
  }
}

/**
 * Run full ingestion for all neighborhoods
 */
async function runFullIngestion(env: Env): Promise<void> {
  // Get all active neighborhoods
  const result = await env.DB.prepare('SELECT id FROM neighborhoods WHERE is_active = 1').all<{ id: string }>();
  const neighborhoods = result.results;
  
  for (const neighborhood of neighborhoods) {
    // Ingest from all configured sources
    for (const source of Object.keys(CAMPAIGN_SOURCES)) {
      await env.CAMPAIGN_QUEUE.send({
        type: 'ingest',
        source,
        neighborhood_id: neighborhood.id,
        timestamp: toISODateString()
      });
    }
  }
}

/**
 * Expire old campaigns
 */
async function expireCampaigns(env: Env): Promise<number> {
  // Get grace period from settings (default 72 hours)
  const settings = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'campaign_grace_period_hours'")
    .first<{ value: string }>();
  
  const gracePeriod = settings ? parseInt(settings.value) : 72;
  
  return await expireOldCampaigns(env.DB, gracePeriod);
}

/**
 * Main queue handler for campaign ingestion
 */
export async function handleCampaignQueue(
  batch: MessageBatch<CampaignQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;
    
    try {
      switch (msg.type) {
        case 'ingest':
          if (msg.source && msg.neighborhood_id) {
            const count = await ingestFromSource(env, msg.source, msg.neighborhood_id);
            console.log(`Ingested ${count} campaigns from ${msg.source}`);
          }
          break;
          
        case 'expire_old':
          const expiredCount = await expireCampaigns(env);
          console.log(`Expired ${expiredCount} old campaigns`);
          break;
      }
      
      message.ack();
    } catch (error) {
      console.error('Campaign ingestion error:', error);
      message.retry();
    }
  }
}

/**
 * Scheduled handler for campaign ingestion
 * Runs every 12 hours via cron trigger
 */
export async function handleScheduledCampaignIngestion(env: Env): Promise<void> {
  console.log('Running scheduled campaign ingestion...');
  
  // Run full ingestion
  await runFullIngestion(env);
  
  // Expire old campaigns
  await expireCampaigns(env);
  
  console.log('Scheduled campaign ingestion complete');
}

/**
 * Manual ingestion endpoint handler (for testing)
 */
export async function triggerIngestion(env: Env, neighborhoodId?: string, source?: string): Promise<{ ingested: number }> {
  if (neighborhoodId && source) {
    const count = await ingestFromSource(env, source, neighborhoodId);
    return { ingested: count };
  }
  
  // Run full ingestion
  await runFullIngestion(env);
  
  return { ingested: 0 };
}
