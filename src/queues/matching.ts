/**
 * Wihda Backend - Matching Logic
 * Queue consumer for matching offers and needs
 */

import type { Env, MatchingQueueMessage, LeftoverOffer, LeftoverNeed, LeftoverSurvey } from '../types';
import { getLeftoverOfferById, getActiveLeftoverOffers, getLeftoverNeedById, getActiveLeftoverNeeds, createMatch, createChatThread } from '../lib/db';
import { safeJsonParse, toISODateString } from '../lib/utils';

/**
 * Calculate match score between an offer and a need
 */
export function calculateMatchScore(offer: LeftoverOffer, need: LeftoverNeed): { score: number; reasons: string[] } {
  const offerSurvey = safeJsonParse<LeftoverSurvey>(offer.survey_json, {} as LeftoverSurvey);
  const needSurvey = safeJsonParse<LeftoverSurvey>(need.survey_json, {} as LeftoverSurvey);
  
  const reasons: string[] = [];
  let totalScore = 0;
  let maxScore = 0;
  
  // 1. Food type match (weight: 0.5)
  maxScore += 50;
  if (offerSurvey.food_type === needSurvey.food_type) {
    totalScore += 50;
    reasons.push('Food type matches');
  } else if (needSurvey.food_type === 'other' || offerSurvey.food_type === 'other') {
    totalScore += 25;
    reasons.push('Food type compatible');
  }
  
  // 2. Diet constraints match (weight: 0.2)
  maxScore += 20;
  const offerConstraints = new Set(offerSurvey.diet_constraints || []);
  const needConstraints = new Set(needSurvey.diet_constraints || []);
  
  if (needConstraints.size === 0 || offerConstraints.size === 0) {
    totalScore += 20;
    reasons.push('No specific dietary requirements');
  } else {
    // Check if offer satisfies all need constraints
    const satisfiedConstraints = [...needConstraints].filter(c => offerConstraints.has(c));
    const score = (satisfiedConstraints.length / needConstraints.size) * 20;
    totalScore += score;
    if (satisfiedConstraints.length === needConstraints.size) {
      reasons.push('All dietary requirements satisfied');
    } else if (satisfiedConstraints.length > 0) {
      reasons.push(`${satisfiedConstraints.length}/${needConstraints.size} dietary requirements satisfied`);
    }
  }
  
  // 3. Portions match (weight: 0.15)
  maxScore += 15;
  if (offerSurvey.portions >= needSurvey.portions) {
    totalScore += 15;
    reasons.push('Sufficient portions available');
  } else {
    // Partial score if offer has at least half the needed portions
    const ratio = offerSurvey.portions / needSurvey.portions;
    totalScore += ratio * 15;
    if (ratio >= 0.5) {
      reasons.push('Partial portion match');
    }
  }
  
  // 4. Pickup time match (weight: 0.1)
  maxScore += 10;
  if (offerSurvey.pickup_time_preference === needSurvey.pickup_time_preference) {
    totalScore += 10;
    reasons.push('Pickup time matches');
  } else if (offerSurvey.pickup_time_preference === 'flexible' || needSurvey.pickup_time_preference === 'flexible') {
    totalScore += 7;
    reasons.push('Flexible pickup time');
  } else {
    // Morning/afternoon overlap is reasonable
    totalScore += 3;
  }
  
  // 5. Distance match (weight: 0.05)
  maxScore += 5;
  const minDistance = Math.min(
    offerSurvey.distance_willing_km || 5,
    needSurvey.distance_willing_km || 5
  );
  totalScore += 5; // Assume within distance for same neighborhood
  reasons.push(`Within ${minDistance}km`);
  
  const normalizedScore = totalScore / maxScore;
  
  return { score: normalizedScore, reasons };
}

/**
 * Run matching for a specific offer
 */
async function matchOffer(
  env: Env,
  offerId: string,
  neighborhoodId: string
): Promise<void> {
  const offer = await getLeftoverOfferById(env.DB, offerId);
  if (!offer || offer.status !== 'active') {
    return;
  }
  
  // Get all active needs in the same neighborhood
  const needs = await getActiveLeftoverNeeds(env.DB, neighborhoodId);
  
  // Filter out needs from the same user
  const candidateNeeds = needs.filter(n => n.user_id !== offer.user_id);
  
  // Calculate scores and sort
  const scoredMatches = candidateNeeds.map(need => {
    const { score, reasons } = calculateMatchScore(offer, need);
    return { need, score, reasons };
  }).filter(m => m.score >= 0.4) // Minimum threshold
    .sort((a, b) => b.score - a.score);
  
  // Create match for the best candidate
  if (scoredMatches.length > 0) {
    const best = scoredMatches[0];
    
    try {
      // Create match
      const match = await createMatch(env.DB, {
        neighborhoodId,
        offerId: offer.id,
        needId: best.need.id,
        offerUserId: offer.user_id,
        needUserId: best.need.user_id,
        score: best.score,
        matchReason: JSON.stringify(best.reasons)
      });
      
      // Create chat thread
      await createChatThread(env.DB, {
        matchId: match.id,
        neighborhoodId,
        participant1Id: offer.user_id,
        participant2Id: best.need.user_id
      });
      
      // Send notifications to both users
      await Promise.all([
        env.NOTIFICATION_QUEUE.send({
          user_id: offer.user_id,
          type: 'match_created',
          title: 'New Match!',
          body: `Your offer "${offer.title}" has been matched with a neighbor in need.`,
          data: { match_id: match.id },
          timestamp: toISODateString()
        }),
        env.NOTIFICATION_QUEUE.send({
          user_id: best.need.user_id,
          type: 'match_created',
          title: 'New Match!',
          body: 'A leftover offer has been matched with your need.',
          data: { match_id: match.id },
          timestamp: toISODateString()
        })
      ]);
      
      console.log(`Created match ${match.id} with score ${best.score}`);
    } catch (error) {
      // Match may already exist - this is fine
      console.log('Match creation skipped (may already exist)');
    }
  }
}

/**
 * Run matching for a specific need
 */
async function matchNeed(
  env: Env,
  needId: string,
  neighborhoodId: string
): Promise<void> {
  const need = await getLeftoverNeedById(env.DB, needId);
  if (!need || need.status !== 'active') {
    return;
  }
  
  // Get all active offers in the same neighborhood
  const offers = await getActiveLeftoverOffers(env.DB, neighborhoodId);
  
  // Filter out offers from the same user
  const candidateOffers = offers.filter(o => o.user_id !== need.user_id);
  
  // Calculate scores and sort
  const scoredMatches = candidateOffers.map(offer => {
    const { score, reasons } = calculateMatchScore(offer, need);
    return { offer, score, reasons };
  }).filter(m => m.score >= 0.4)
    .sort((a, b) => b.score - a.score);
  
  // Create match for the best candidate
  if (scoredMatches.length > 0) {
    const best = scoredMatches[0];
    
    try {
      const match = await createMatch(env.DB, {
        neighborhoodId,
        offerId: best.offer.id,
        needId: need.id,
        offerUserId: best.offer.user_id,
        needUserId: need.user_id,
        score: best.score,
        matchReason: JSON.stringify(best.reasons)
      });
      
      await createChatThread(env.DB, {
        matchId: match.id,
        neighborhoodId,
        participant1Id: best.offer.user_id,
        participant2Id: need.user_id
      });
      
      await Promise.all([
        env.NOTIFICATION_QUEUE.send({
          user_id: best.offer.user_id,
          type: 'match_created',
          title: 'New Match!',
          body: `Your offer "${best.offer.title}" has been matched with a neighbor in need.`,
          data: { match_id: match.id },
          timestamp: toISODateString()
        }),
        env.NOTIFICATION_QUEUE.send({
          user_id: need.user_id,
          type: 'match_created',
          title: 'New Match!',
          body: 'A leftover offer has been matched with your need.',
          data: { match_id: match.id },
          timestamp: toISODateString()
        })
      ]);
      
      console.log(`Created match ${match.id} with score ${best.score}`);
    } catch (error) {
      console.log('Match creation skipped (may already exist)');
    }
  }
}

/**
 * Run scheduled matching for all active offers/needs in a neighborhood
 */
async function runScheduledMatching(
  env: Env,
  neighborhoodId: string
): Promise<void> {
  // Get all active offers and needs
  const [offers, needs] = await Promise.all([
    getActiveLeftoverOffers(env.DB, neighborhoodId),
    getActiveLeftoverNeeds(env.DB, neighborhoodId)
  ]);
  
  // Find best matches using stable matching algorithm (simplified)
  const matchedOffers = new Set<string>();
  const matchedNeeds = new Set<string>();
  
  // Calculate all pairwise scores
  const allScores: { offer: LeftoverOffer; need: LeftoverNeed; score: number }[] = [];
  
  for (const offer of offers) {
    for (const need of needs) {
      if (offer.user_id === need.user_id) continue;
      
      const { score } = calculateMatchScore(offer, need);
      if (score >= 0.4) {
        allScores.push({ offer, need, score });
      }
    }
  }
  
  // Sort by score descending
  allScores.sort((a, b) => b.score - a.score);
  
  // Greedy matching
  for (const { offer, need, score } of allScores) {
    if (matchedOffers.has(offer.id) || matchedNeeds.has(need.id)) continue;
    
    try {
      const match = await createMatch(env.DB, {
        neighborhoodId,
        offerId: offer.id,
        needId: need.id,
        offerUserId: offer.user_id,
        needUserId: need.user_id,
        score,
        matchReason: JSON.stringify(['Scheduled match'])
      });
      
      await createChatThread(env.DB, {
        matchId: match.id,
        neighborhoodId,
        participant1Id: offer.user_id,
        participant2Id: need.user_id
      });
      
      matchedOffers.add(offer.id);
      matchedNeeds.add(need.id);
      
      await Promise.all([
        env.NOTIFICATION_QUEUE.send({
          user_id: offer.user_id,
          type: 'match_created',
          title: 'New Match!',
          body: `Your offer "${offer.title}" has been matched with a neighbor in need.`,
          data: { match_id: match.id },
          timestamp: toISODateString()
        }),
        env.NOTIFICATION_QUEUE.send({
          user_id: need.user_id,
          type: 'match_created',
          title: 'New Match!',
          body: 'A leftover offer has been matched with your need.',
          data: { match_id: match.id },
          timestamp: toISODateString()
        })
      ]);
      
      console.log(`Scheduled match created: ${match.id}`);
    } catch (error) {
      // Skip if match already exists
    }
  }
}

/**
 * Main queue handler for matching
 */
export async function handleMatchingQueue(
  batch: MessageBatch<MatchingQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;
    
    try {
      switch (msg.type) {
        case 'match_offer':
          if (msg.offer_id && msg.neighborhood_id) {
            await matchOffer(env, msg.offer_id, msg.neighborhood_id);
          }
          break;
          
        case 'match_need':
          if (msg.need_id && msg.neighborhood_id) {
            await matchNeed(env, msg.need_id, msg.neighborhood_id);
          }
          break;
          
        case 'scheduled_matching':
          if (msg.neighborhood_id) {
            await runScheduledMatching(env, msg.neighborhood_id);
          }
          break;
      }
      
      message.ack();
    } catch (error) {
      console.error('Matching error:', error);
      message.retry();
    }
  }
}
