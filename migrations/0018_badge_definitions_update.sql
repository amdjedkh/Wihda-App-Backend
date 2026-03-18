-- 0018: Update badge definitions to match new spec
-- New requirement types: campaigns_joined, total_activities

UPDATE badges SET
  requirement_type  = 'campaigns_joined',
  requirement_value = 1,
  description       = 'Join your first community volunteer activity'
WHERE key = 'food_saver';

UPDATE badges SET
  requirement_type  = 'leftover_offers',
  requirement_value = 10,
  description       = 'Complete 10 giving or sharing actions for your neighbors'
WHERE key = 'local_giver';

UPDATE badges SET
  requirement_type  = 'total_activities',
  requirement_value = 10,
  description       = 'Complete 10 total activities — volunteering and cleanify combined'
WHERE key = 'active_member';

UPDATE badges SET
  requirement_type  = 'cleanify_approved',
  requirement_value = 5,
  description       = 'Complete 5 verified cleanify submissions'
WHERE key = 'cleanify_champion';

UPDATE badges SET
  requirement_type  = 'total_activities',
  requirement_value = 15,
  description       = 'Complete 15 total activities to earn this prestigious title'
WHERE key = 'citizen_of_month';

UPDATE badges SET
  requirement_type  = 'campaigns_joined',
  requirement_value = 7,
  description       = 'Join 7 volunteer activities in the community'
WHERE key = 'top_helper';
