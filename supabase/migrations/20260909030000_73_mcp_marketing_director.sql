-- Phase 9: prepared for Alex/CoS release; never applies tokens or client grants.
begin;
delete from mcp_internal.mcp_bot_permissions where bot_id = 'bot_marketing';
insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by) values
  ('bot_marketing', 'campaign.list', 'alex-locked:phase-9'),
  ('bot_marketing', 'campaign.get', 'alex-locked:phase-9'),
  ('bot_marketing', 'campaign.get_status', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.list_ideas', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.get_idea', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.get_brief', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.get_production_status', 'alex-locked:phase-9'),
  ('bot_marketing', 'attribution.get_campaign_performance', 'alex-locked:phase-9'),
  ('bot_marketing', 'delivery.get_client', 'alex-locked:phase-9'),
  ('bot_marketing', 'delivery.get_status', 'alex-locked:phase-9'),
  ('bot_marketing', 'delivery.get_client_health', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.get_pending_approvals', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.get_activity', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.list_tasks', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.get_task', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.generate_brief', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.request_revision', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.request_approval', 'alex-locked:phase-9'),
  ('bot_marketing', 'content.create_repurpose_plan', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.create_task', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.assign_task', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.complete_task', 'alex-locked:phase-9'),
  ('bot_marketing', 'workflow.create_approval', 'alex-locked:phase-9');
commit;
