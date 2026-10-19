export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_job_events: {
        Row: {
          created_at: string
          description: string
          id: string
          job_id: string
          level: string
          payload: Json | null
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          job_id: string
          level?: string
          payload?: Json | null
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          job_id?: string
          level?: string
          payload?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "agent_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      agent_jobs: {
        Row: {
          agent_key: string
          attempts: number
          client_id: string | null
          completed_at: string | null
          cost_usd: number
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          input_id: string | null
          input_table: string | null
          input_tokens: number
          lease_owner: string | null
          lease_until: string | null
          max_attempts: number
          output_tokens: number
          params: Json
          run_after: string | null
          run_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          terminal: boolean
        }
        Insert: {
          agent_key: string
          attempts?: number
          client_id?: string | null
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          input_id?: string | null
          input_table?: string | null
          input_tokens?: number
          lease_owner?: string | null
          lease_until?: string | null
          max_attempts?: number
          output_tokens?: number
          params?: Json
          run_after?: string | null
          run_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          terminal?: boolean
        }
        Update: {
          agent_key?: string
          attempts?: number
          client_id?: string | null
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          input_id?: string | null
          input_table?: string | null
          input_tokens?: number
          lease_owner?: string | null
          lease_until?: string | null
          max_attempts?: number
          output_tokens?: number
          params?: Json
          run_after?: string | null
          run_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          terminal?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "agent_jobs_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agent_stats"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "agent_jobs_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "agent_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "agent_jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runtime_heartbeats: {
        Row: {
          active_jobs: number | null
          id: string
          metadata: Json
          queue_depth: number | null
          reported_at: string
          status: string
          version: string | null
          worker_id: string
        }
        Insert: {
          active_jobs?: number | null
          id?: string
          metadata?: Json
          queue_depth?: number | null
          reported_at?: string
          status?: string
          version?: string | null
          worker_id: string
        }
        Update: {
          active_jobs?: number | null
          id?: string
          metadata?: Json
          queue_depth?: number | null
          reported_at?: string
          status?: string
          version?: string | null
          worker_id?: string
        }
        Relationships: []
      }
      agents: {
        Row: {
          agent_key: string
          archived_at: string | null
          config: Json
          created_at: string
          description: string | null
          domain: string | null
          id: string
          initials: string
          name: string
          paused: boolean
          requires_input: boolean
          requires_upstream: string[]
          scheduled_only: boolean
          updated_at: string
        }
        Insert: {
          agent_key: string
          archived_at?: string | null
          config?: Json
          created_at?: string
          description?: string | null
          domain?: string | null
          id?: string
          initials: string
          name: string
          paused?: boolean
          requires_input?: boolean
          requires_upstream?: string[]
          scheduled_only?: boolean
          updated_at?: string
        }
        Update: {
          agent_key?: string
          archived_at?: string | null
          config?: Json
          created_at?: string
          description?: string | null
          domain?: string | null
          id?: string
          initials?: string
          name?: string
          paused?: boolean
          requires_input?: boolean
          requires_upstream?: string[]
          scheduled_only?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      archived_leads: {
        Row: {
          archived_at: string
          archived_by: string | null
          client_id: string
          events: Json
          id: string
          lead: Json
          name: string | null
          reason: string | null
          stage_at_archive: Database["public"]["Enums"]["lead_stage"]
        }
        Insert: {
          archived_at?: string
          archived_by?: string | null
          client_id: string
          events?: Json
          id: string
          lead: Json
          name?: string | null
          reason?: string | null
          stage_at_archive: Database["public"]["Enums"]["lead_stage"]
        }
        Update: {
          archived_at?: string
          archived_by?: string | null
          client_id?: string
          events?: Json
          id?: string
          lead?: Json
          name?: string | null
          reason?: string | null
          stage_at_archive?: Database["public"]["Enums"]["lead_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "archived_leads_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "archived_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "archived_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "archived_leads_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "lead_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_events: {
        Row: {
          actor: string
          actor_id: string | null
          assignment_id: string
          created_at: string
          from_stage: Database["public"]["Enums"]["assignment_stage"] | null
          id: string
          note: string | null
          to_stage: Database["public"]["Enums"]["assignment_stage"]
        }
        Insert: {
          actor?: string
          actor_id?: string | null
          assignment_id: string
          created_at?: string
          from_stage?: Database["public"]["Enums"]["assignment_stage"] | null
          id?: string
          note?: string | null
          to_stage: Database["public"]["Enums"]["assignment_stage"]
        }
        Update: {
          actor?: string
          actor_id?: string | null
          assignment_id?: string
          created_at?: string
          from_stage?: Database["public"]["Enums"]["assignment_stage"] | null
          id?: string
          note?: string | null
          to_stage?: Database["public"]["Enums"]["assignment_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "assignment_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_board"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "assignment_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "job_assignments"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_transitions: {
        Row: {
          from_stage: Database["public"]["Enums"]["assignment_stage"]
          note: string | null
          to_stage: Database["public"]["Enums"]["assignment_stage"]
        }
        Insert: {
          from_stage: Database["public"]["Enums"]["assignment_stage"]
          note?: string | null
          to_stage: Database["public"]["Enums"]["assignment_stage"]
        }
        Update: {
          from_stage?: Database["public"]["Enums"]["assignment_stage"]
          note?: string | null
          to_stage?: Database["public"]["Enums"]["assignment_stage"]
        }
        Relationships: []
      }
      brief_dispatches: {
        Row: {
          assignment_id: string | null
          brief_id: string
          brief_role: string
          client_id: string
          created_at: string
          email_error: string | null
          email_status: string
          emailed_at: string | null
          id: string
          job_id: string | null
          member_id: string
          sent_by: string | null
          source_asset_id: string | null
        }
        Insert: {
          assignment_id?: string | null
          brief_id: string
          brief_role?: string
          client_id: string
          created_at?: string
          email_error?: string | null
          email_status?: string
          emailed_at?: string | null
          id?: string
          job_id?: string | null
          member_id: string
          sent_by?: string | null
          source_asset_id?: string | null
        }
        Update: {
          assignment_id?: string | null
          brief_id?: string
          brief_role?: string
          client_id?: string
          created_at?: string
          email_error?: string | null
          email_status?: string
          emailed_at?: string | null
          id?: string
          job_id?: string | null
          member_id?: string
          sent_by?: string | null
          source_asset_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brief_dispatches_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_board"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "brief_dispatches_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "job_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "brief_dispatches_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "brief_dispatches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "brief_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "brief_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "brief_dispatches_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "brief_dispatches_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_action_approvals: {
        Row: {
          action_key: string
          artifact_version_hash: string
          campaign_id: string
          client_id: string
          decided_at: string | null
          decided_by: string | null
          destination: string
          id: string
          idempotency_key: string
          manifest_id: string
          rejection_reason: string | null
          request_hash: string
          requested_at: string
          scope: Json
          status: string
        }
        Insert: {
          action_key: string
          artifact_version_hash: string
          campaign_id: string
          client_id: string
          decided_at?: string | null
          decided_by?: string | null
          destination: string
          id?: string
          idempotency_key: string
          manifest_id: string
          rejection_reason?: string | null
          request_hash: string
          requested_at?: string
          scope: Json
          status?: string
        }
        Update: {
          action_key?: string
          artifact_version_hash?: string
          campaign_id?: string
          client_id?: string
          decided_at?: string | null
          decided_by?: string | null
          destination?: string
          id?: string
          idempotency_key?: string
          manifest_id?: string
          rejection_reason?: string | null
          request_hash?: string
          requested_at?: string
          scope?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_action_approvals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_action_approvals_manifest_id_campaign_id_client_i_fkey"
            columns: ["manifest_id", "campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaign_manifest_versions"
            referencedColumns: ["id", "campaign_id", "client_id"]
          },
        ]
      }
      campaign_artifact_offer_inputs: {
        Row: {
          artifact_id: string
          artifact_kind: string
          campaign_id: string
          captured_at: string
          client_id: string
          job_id: string
          manifest_id: string
          offer_snapshot: Json
          offer_version_id: string
        }
        Insert: {
          artifact_id: string
          artifact_kind: string
          campaign_id: string
          captured_at?: string
          client_id: string
          job_id: string
          manifest_id: string
          offer_snapshot: Json
          offer_version_id: string
        }
        Update: {
          artifact_id?: string
          artifact_kind?: string
          campaign_id?: string
          captured_at?: string
          client_id?: string
          job_id?: string
          manifest_id?: string
          offer_snapshot?: Json
          offer_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_artifact_offer_input_manifest_id_campaign_id_clie_fkey"
            columns: ["manifest_id", "campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaign_manifest_versions"
            referencedColumns: ["id", "campaign_id", "client_id"]
          },
          {
            foreignKeyName: "campaign_artifact_offer_inputs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifact_offer_inputs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "campaign_artifact_offer_inputs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "campaign_artifact_offer_inputs_offer_version_id_client_id_fkey"
            columns: ["offer_version_id", "client_id"]
            isOneToOne: false
            referencedRelation: "service_offer_versions"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      campaign_artifacts: {
        Row: {
          asset_id: string | null
          brief_id: string | null
          campaign_id: string
          client_id: string
          created_at: string
          id: string
          kind: string
          manifest_id: string | null
          page_id: string | null
          post_id: string | null
          sales_agent_id: string | null
        }
        Insert: {
          asset_id?: string | null
          brief_id?: string | null
          campaign_id: string
          client_id: string
          created_at?: string
          id?: string
          kind: string
          manifest_id?: string | null
          page_id?: string | null
          post_id?: string | null
          sales_agent_id?: string | null
        }
        Update: {
          asset_id?: string | null
          brief_id?: string | null
          campaign_id?: string
          client_id?: string
          created_at?: string
          id?: string
          kind?: string
          manifest_id?: string | null
          page_id?: string | null
          post_id?: string | null
          sales_agent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_manifest_identity_fk"
            columns: ["manifest_id", "campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaign_manifest_versions"
            referencedColumns: ["id", "campaign_id", "client_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "distribution_due"
            referencedColumns: ["schedule_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "post_copy_effective"
            referencedColumns: ["scheduled_post_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["post_id"]
          },
          {
            foreignKeyName: "campaign_artifacts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_sales_agent_id_fkey"
            columns: ["sales_agent_id"]
            isOneToOne: false
            referencedRelation: "client_sales_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_artifacts_sales_agent_id_fkey"
            columns: ["sales_agent_id"]
            isOneToOne: false
            referencedRelation: "sales_agents_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_content_pillars: {
        Row: {
          campaign_id: string
          created_at: string
          pillar_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          pillar_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          pillar_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_content_pillars_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_content_pillars_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_content_pillars_pillar_id_fkey"
            columns: ["pillar_id"]
            isOneToOne: false
            referencedRelation: "client_content_pillars"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_intelligence_snapshots: {
        Row: {
          acquisition_mode: string
          brief: string
          business_context: Json
          campaign_id: string
          captured_at: string
          client_id: string
          content_pillars: Json
          id: string
          missing_domains: string[]
          paid_platform: string | null
          planner_job_id: string
          snapshot_hash: string
          source_records: Json
        }
        Insert: {
          acquisition_mode: string
          brief: string
          business_context: Json
          campaign_id: string
          captured_at?: string
          client_id: string
          content_pillars: Json
          id?: string
          missing_domains?: string[]
          paid_platform?: string | null
          planner_job_id: string
          snapshot_hash: string
          source_records: Json
        }
        Update: {
          acquisition_mode?: string
          brief?: string
          business_context?: Json
          campaign_id?: string
          captured_at?: string
          client_id?: string
          content_pillars?: Json
          id?: string
          missing_domains?: string[]
          paid_platform?: string | null
          planner_job_id?: string
          snapshot_hash?: string
          source_records?: Json
        }
        Relationships: [
          {
            foreignKeyName: "campaign_intelligence_snapshots_campaign_id_client_id_fkey"
            columns: ["campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "campaign_intelligence_snapshots_campaign_id_client_id_fkey"
            columns: ["campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      campaign_manifest_intelligence: {
        Row: {
          campaign_id: string
          client_id: string
          manifest_id: string
          snapshot_id: string
        }
        Insert: {
          campaign_id: string
          client_id: string
          manifest_id: string
          snapshot_id: string
        }
        Update: {
          campaign_id?: string
          client_id?: string
          manifest_id?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_manifest_intelligenc_manifest_id_campaign_id_clie_fkey"
            columns: ["manifest_id", "campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaign_manifest_versions"
            referencedColumns: ["id", "campaign_id", "client_id"]
          },
          {
            foreignKeyName: "campaign_manifest_intelligenc_snapshot_id_campaign_id_clie_fkey"
            columns: ["snapshot_id", "campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaign_intelligence_snapshots"
            referencedColumns: ["id", "campaign_id", "client_id"]
          },
        ]
      }
      campaign_manifest_items: {
        Row: {
          depends_on: string[]
          external_activation: boolean
          item_key: string
          manifest_id: string
          module_key: string
          required: boolean
        }
        Insert: {
          depends_on?: string[]
          external_activation?: boolean
          item_key: string
          manifest_id: string
          module_key: string
          required: boolean
        }
        Update: {
          depends_on?: string[]
          external_activation?: boolean
          item_key?: string
          manifest_id?: string
          module_key?: string
          required?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "campaign_manifest_items_manifest_id_fkey"
            columns: ["manifest_id"]
            isOneToOne: false
            referencedRelation: "campaign_manifest_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_manifest_offers: {
        Row: {
          campaign_id: string
          client_id: string
          linked_at: string
          manifest_id: string
          offer_version_id: string
        }
        Insert: {
          campaign_id: string
          client_id: string
          linked_at?: string
          manifest_id: string
          offer_version_id: string
        }
        Update: {
          campaign_id?: string
          client_id?: string
          linked_at?: string
          manifest_id?: string
          offer_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_manifest_offers_manifest_id_campaign_id_client_id_fkey"
            columns: ["manifest_id", "campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaign_manifest_versions"
            referencedColumns: ["id", "campaign_id", "client_id"]
          },
          {
            foreignKeyName: "campaign_manifest_offers_offer_version_id_client_id_fkey"
            columns: ["offer_version_id", "client_id"]
            isOneToOne: false
            referencedRelation: "service_offer_versions"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      campaign_manifest_versions: {
        Row: {
          acquisition_mode: string
          campaign_id: string
          client_id: string
          created_at: string
          id: string
          idempotency_key: string
          paid_platform: string | null
          plan_hash: string
          plan_snapshot: Json
          version: number
        }
        Insert: {
          acquisition_mode: string
          campaign_id: string
          client_id: string
          created_at?: string
          id?: string
          idempotency_key: string
          paid_platform?: string | null
          plan_hash: string
          plan_snapshot: Json
          version: number
        }
        Update: {
          acquisition_mode?: string
          campaign_id?: string
          client_id?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          paid_platform?: string | null
          plan_hash?: string
          plan_snapshot?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaign_manifest_versions_campaign_id_client_id_fkey"
            columns: ["campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "campaign_manifest_versions_campaign_id_client_id_fkey"
            columns: ["campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      campaign_page_approval_snapshots: {
        Row: {
          approval_id: string
          client_id: string
          created_at: string
          page_id: string
          rendered_html: string
          rendered_sha256: string
          revision_id: string
          site_path: string
          site_repository_id: string
        }
        Insert: {
          approval_id: string
          client_id: string
          created_at?: string
          page_id: string
          rendered_html: string
          rendered_sha256: string
          revision_id: string
          site_path: string
          site_repository_id: string
        }
        Update: {
          approval_id?: string
          client_id?: string
          created_at?: string
          page_id?: string
          rendered_html?: string
          rendered_sha256?: string
          revision_id?: string
          site_path?: string
          site_repository_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_page_approval_snapshots_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: true
            referencedRelation: "campaign_action_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_page_approval_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_page_approval_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "campaign_page_approval_snapshots_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_page_approval_snapshots_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_page_approval_snapshots_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "client_page_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_page_approval_snapshots_site_repository_id_fkey"
            columns: ["site_repository_id"]
            isOneToOne: false
            referencedRelation: "client_site_repositories"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          campaign_ref: string
          client_id: string | null
          created_at: string
          created_by: string | null
          daily_spend: number
          ended_on: string | null
          external_id: string | null
          id: string
          objective_achieved: string | null
          started_on: string
          status: Database["public"]["Enums"]["campaign_status"]
          target_role: string
          total_spend: number
          updated_at: string
        }
        Insert: {
          campaign_ref: string
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          daily_spend?: number
          ended_on?: string | null
          external_id?: string | null
          id?: string
          objective_achieved?: string | null
          started_on?: string
          status?: Database["public"]["Enums"]["campaign_status"]
          target_role: string
          total_spend?: number
          updated_at?: string
        }
        Update: {
          campaign_ref?: string
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          daily_spend?: number
          ended_on?: string | null
          external_id?: string | null
          id?: string
          objective_achieved?: string | null
          started_on?: string
          status?: Database["public"]["Enums"]["campaign_status"]
          target_role?: string
          total_spend?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "campaigns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_members: {
        Row: {
          added_at: string
          added_by: string | null
          channel_id: string
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          channel_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          channel_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_members_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "team_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_agent_inputs: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          domain: Database["public"]["Enums"]["record_domain"]
          id: string
          notes: string | null
          payload: Json
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          domain: Database["public"]["Enums"]["record_domain"]
          id?: string
          notes?: string | null
          payload?: Json
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          domain?: Database["public"]["Enums"]["record_domain"]
          id?: string
          notes?: string | null
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "client_agent_inputs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_agent_inputs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_agent_inputs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_agent_records: {
        Row: {
          body: string | null
          client_id: string
          created_at: string
          display_order: number
          domain: Database["public"]["Enums"]["record_domain"]
          edited_at: string | null
          edited_by: string | null
          id: string
          item_key: string
          item_type: string
          job_id: string | null
          period: string | null
          status: Database["public"]["Enums"]["record_status"]
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          client_id: string
          created_at?: string
          display_order?: number
          domain: Database["public"]["Enums"]["record_domain"]
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          item_key: string
          item_type?: string
          job_id?: string | null
          period?: string | null
          status?: Database["public"]["Enums"]["record_status"]
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          client_id?: string
          created_at?: string
          display_order?: number
          domain?: Database["public"]["Enums"]["record_domain"]
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          item_key?: string
          item_type?: string
          job_id?: string | null
          period?: string | null
          status?: Database["public"]["Enums"]["record_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_agent_records_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_agent_records_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_agent_records_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_agent_records_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_agent_records_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_agent_records_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      client_asset_reviews: {
        Row: {
          asset_id: string
          created_at: string
          decision: Database["public"]["Enums"]["review_status"]
          id: string
          reason: string | null
          reviewed_by: string | null
          reviewed_by_bot: string | null
        }
        Insert: {
          asset_id: string
          created_at?: string
          decision: Database["public"]["Enums"]["review_status"]
          id?: string
          reason?: string | null
          reviewed_by?: string | null
          reviewed_by_bot?: string | null
        }
        Update: {
          asset_id?: string
          created_at?: string
          decision?: Database["public"]["Enums"]["review_status"]
          id?: string
          reason?: string | null
          reviewed_by?: string | null
          reviewed_by_bot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_asset_reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_asset_reviews_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_assignments: {
        Row: {
          client_id: string
          compensation: number | null
          created_at: string
          due_date: string | null
          ended_at: string | null
          id: string
          member_id: string
          updated_at: string
        }
        Insert: {
          client_id: string
          compensation?: number | null
          created_at?: string
          due_date?: string | null
          ended_at?: string | null
          id?: string
          member_id: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          compensation?: number | null
          created_at?: string
          due_date?: string | null
          ended_at?: string | null
          id?: string
          member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_assignments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      client_audit_notes: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          id: string
          member_id: string | null
          note: string
          noted_on: string
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          member_id?: string | null
          note: string
          noted_on?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          member_id?: string | null
          note?: string
          noted_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_audit_notes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_audit_notes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_audit_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_audit_notes_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      client_billing: {
        Row: {
          client_id: string
          current_plan: string | null
          monthly_amount: number | null
          started_on: string | null
          updated_at: string
          upsell_opportunity: string | null
        }
        Insert: {
          client_id: string
          current_plan?: string | null
          monthly_amount?: number | null
          started_on?: string | null
          updated_at?: string
          upsell_opportunity?: string | null
        }
        Update: {
          client_id?: string
          current_plan?: string | null
          monthly_amount?: number | null
          started_on?: string | null
          updated_at?: string
          upsell_opportunity?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_billing_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_billing_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_brand_profiles: {
        Row: {
          client_id: string
          colour_accent: string | null
          colour_background: string | null
          colour_primary: string | null
          colour_secondary: string | null
          colour_text: string | null
          composition_notes: string | null
          custom_css: string | null
          font_body: string | null
          font_heading: string | null
          imagery_style: string | null
          lighting: string | null
          mood: string | null
          never_do: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          colour_accent?: string | null
          colour_background?: string | null
          colour_primary?: string | null
          colour_secondary?: string | null
          colour_text?: string | null
          composition_notes?: string | null
          custom_css?: string | null
          font_body?: string | null
          font_heading?: string | null
          imagery_style?: string | null
          lighting?: string | null
          mood?: string | null
          never_do?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          colour_accent?: string | null
          colour_background?: string | null
          colour_primary?: string | null
          colour_secondary?: string | null
          colour_text?: string | null
          composition_notes?: string | null
          custom_css?: string | null
          font_body?: string | null
          font_heading?: string | null
          imagery_style?: string | null
          lighting?: string | null
          mood?: string | null
          never_do?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_brand_profiles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_brand_profiles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_briefs: {
        Row: {
          apply_url: string | null
          archived_at: string | null
          argument: string | null
          avatar_brief: string | null
          b_roll: string | null
          body: string | null
          brief_ref: string | null
          call_to_action: string | null
          channel_intent: string | null
          client_id: string
          compensation_text: string | null
          content_format: Database["public"]["Enums"]["content_format"]
          created_at: string
          derived_from_asset_id: string | null
          editor_brief: string | null
          format_code: string | null
          frame_count: number | null
          frame_plan: string[] | null
          hook: string | null
          id: string
          job_id: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          premise: string | null
          production_method: string | null
          proof: string | null
          proof_asset_id: string | null
          purpose: Database["public"]["Enums"]["content_purpose"]
          recruitment_role:
            | Database["public"]["Enums"]["recruitment_role"]
            | null
          repurpose_format: string | null
          script: string | null
          shot_requirements: string | null
          slot_role: string | null
          sound_asset_id: string | null
          sound_treatment: string
          source_idea_id: string | null
          status: Database["public"]["Enums"]["brief_status"]
          target_platform: Database["public"]["Enums"]["post_platform"] | null
          title: string
          updated_at: string
          visual_direction: string | null
        }
        Insert: {
          apply_url?: string | null
          archived_at?: string | null
          argument?: string | null
          avatar_brief?: string | null
          b_roll?: string | null
          body?: string | null
          brief_ref?: string | null
          call_to_action?: string | null
          channel_intent?: string | null
          client_id: string
          compensation_text?: string | null
          content_format?: Database["public"]["Enums"]["content_format"]
          created_at?: string
          derived_from_asset_id?: string | null
          editor_brief?: string | null
          format_code?: string | null
          frame_count?: number | null
          frame_plan?: string[] | null
          hook?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          premise?: string | null
          production_method?: string | null
          proof?: string | null
          proof_asset_id?: string | null
          purpose?: Database["public"]["Enums"]["content_purpose"]
          recruitment_role?:
            | Database["public"]["Enums"]["recruitment_role"]
            | null
          repurpose_format?: string | null
          script?: string | null
          shot_requirements?: string | null
          slot_role?: string | null
          sound_asset_id?: string | null
          sound_treatment?: string
          source_idea_id?: string | null
          status?: Database["public"]["Enums"]["brief_status"]
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
          title: string
          updated_at?: string
          visual_direction?: string | null
        }
        Update: {
          apply_url?: string | null
          archived_at?: string | null
          argument?: string | null
          avatar_brief?: string | null
          b_roll?: string | null
          body?: string | null
          brief_ref?: string | null
          call_to_action?: string | null
          channel_intent?: string | null
          client_id?: string
          compensation_text?: string | null
          content_format?: Database["public"]["Enums"]["content_format"]
          created_at?: string
          derived_from_asset_id?: string | null
          editor_brief?: string | null
          format_code?: string | null
          frame_count?: number | null
          frame_plan?: string[] | null
          hook?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          premise?: string | null
          production_method?: string | null
          proof?: string | null
          proof_asset_id?: string | null
          purpose?: Database["public"]["Enums"]["content_purpose"]
          recruitment_role?:
            | Database["public"]["Enums"]["recruitment_role"]
            | null
          repurpose_format?: string | null
          script?: string | null
          shot_requirements?: string | null
          slot_role?: string | null
          sound_asset_id?: string | null
          sound_treatment?: string
          source_idea_id?: string | null
          status?: Database["public"]["Enums"]["brief_status"]
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
          title?: string
          updated_at?: string
          visual_direction?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_briefs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_briefs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_briefs_proof_asset_id_fkey"
            columns: ["proof_asset_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_sound_asset_id_fkey"
            columns: ["sound_asset_id"]
            isOneToOne: false
            referencedRelation: "video_sound_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_source_idea_id_fkey"
            columns: ["source_idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_source_idea_id_fkey"
            columns: ["source_idea_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
        ]
      }
      client_business_context: {
        Row: {
          brand_voice: string | null
          business_overview: string | null
          business_type: string | null
          client_id: string
          competitors: string | null
          created_at: string
          current_marketing: string | null
          current_revenue: string | null
          ideal_customer: string | null
          main_offer: string | null
          proof_testimonials: string | null
          sales_process: string | null
          target_revenue: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          brand_voice?: string | null
          business_overview?: string | null
          business_type?: string | null
          client_id: string
          competitors?: string | null
          created_at?: string
          current_marketing?: string | null
          current_revenue?: string | null
          ideal_customer?: string | null
          main_offer?: string | null
          proof_testimonials?: string | null
          sales_process?: string | null
          target_revenue?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          brand_voice?: string | null
          business_overview?: string | null
          business_type?: string | null
          client_id?: string
          competitors?: string | null
          created_at?: string
          current_marketing?: string | null
          current_revenue?: string | null
          ideal_customer?: string | null
          main_offer?: string | null
          proof_testimonials?: string | null
          sales_process?: string | null
          target_revenue?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_business_context_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_business_context_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_business_context_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_campaigns: {
        Row: {
          acquisition_mode: string
          ad_campaign_id: string | null
          archived_at: string | null
          audience: string | null
          brief: string
          budget: number | null
          built_at: string | null
          channels: string[]
          client_id: string
          cloned_from_campaign_id: string | null
          content_count: number
          content_ideas_generated_at: string | null
          conversion_event: string | null
          core_message: string | null
          created_at: string
          daily_budget: number | null
          ends_on: string | null
          entry_state: Database["public"]["Enums"]["audience_state"] | null
          exit_state: Database["public"]["Enums"]["audience_state"] | null
          feeds_from_campaign_id: string | null
          id: string
          ideate_on_plan: boolean
          job_id: string | null
          kpi_metric: string | null
          kpi_target: number | null
          launched_at: string | null
          meta_ad_set_id: string | null
          meta_built_at: string | null
          meta_campaign_id: string | null
          mirrors_template:
            | Database["public"]["Enums"]["campaign_template"]
            | null
          name: string
          needs_landing_page: boolean
          needs_sales_agent: boolean
          objective: string | null
          offer_summary: string | null
          offer_version_id: string | null
          optimisation_event: string | null
          paid_platform: string | null
          starts_on: string | null
          status: string
          target_countries: string[]
          template: Database["public"]["Enums"]["campaign_template"] | null
          updated_at: string
        }
        Insert: {
          acquisition_mode?: string
          ad_campaign_id?: string | null
          archived_at?: string | null
          audience?: string | null
          brief: string
          budget?: number | null
          built_at?: string | null
          channels?: string[]
          client_id: string
          cloned_from_campaign_id?: string | null
          content_count?: number
          content_ideas_generated_at?: string | null
          conversion_event?: string | null
          core_message?: string | null
          created_at?: string
          daily_budget?: number | null
          ends_on?: string | null
          entry_state?: Database["public"]["Enums"]["audience_state"] | null
          exit_state?: Database["public"]["Enums"]["audience_state"] | null
          feeds_from_campaign_id?: string | null
          id?: string
          ideate_on_plan?: boolean
          job_id?: string | null
          kpi_metric?: string | null
          kpi_target?: number | null
          launched_at?: string | null
          meta_ad_set_id?: string | null
          meta_built_at?: string | null
          meta_campaign_id?: string | null
          mirrors_template?:
            | Database["public"]["Enums"]["campaign_template"]
            | null
          name: string
          needs_landing_page?: boolean
          needs_sales_agent?: boolean
          objective?: string | null
          offer_summary?: string | null
          offer_version_id?: string | null
          optimisation_event?: string | null
          paid_platform?: string | null
          starts_on?: string | null
          status?: string
          target_countries?: string[]
          template?: Database["public"]["Enums"]["campaign_template"] | null
          updated_at?: string
        }
        Update: {
          acquisition_mode?: string
          ad_campaign_id?: string | null
          archived_at?: string | null
          audience?: string | null
          brief?: string
          budget?: number | null
          built_at?: string | null
          channels?: string[]
          client_id?: string
          cloned_from_campaign_id?: string | null
          content_count?: number
          content_ideas_generated_at?: string | null
          conversion_event?: string | null
          core_message?: string | null
          created_at?: string
          daily_budget?: number | null
          ends_on?: string | null
          entry_state?: Database["public"]["Enums"]["audience_state"] | null
          exit_state?: Database["public"]["Enums"]["audience_state"] | null
          feeds_from_campaign_id?: string | null
          id?: string
          ideate_on_plan?: boolean
          job_id?: string | null
          kpi_metric?: string | null
          kpi_target?: number | null
          launched_at?: string | null
          meta_ad_set_id?: string | null
          meta_built_at?: string | null
          meta_campaign_id?: string | null
          mirrors_template?:
            | Database["public"]["Enums"]["campaign_template"]
            | null
          name?: string
          needs_landing_page?: boolean
          needs_sales_agent?: boolean
          objective?: string | null
          offer_summary?: string | null
          offer_version_id?: string | null
          optimisation_event?: string | null
          paid_platform?: string | null
          starts_on?: string | null
          status?: string
          target_countries?: string[]
          template?: Database["public"]["Enums"]["campaign_template"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_campaigns_ad_campaign_id_fkey"
            columns: ["ad_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_campaigns_clone_same_client_fkey"
            columns: ["cloned_from_campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "client_campaigns_clone_same_client_fkey"
            columns: ["cloned_from_campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "client_campaigns_feeds_from_campaign_id_fkey"
            columns: ["feeds_from_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_campaigns_feeds_from_campaign_id_fkey"
            columns: ["feeds_from_campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_campaigns_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_campaigns_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_campaigns_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_campaigns_offer_version_client_fk"
            columns: ["offer_version_id", "client_id"]
            isOneToOne: false
            referencedRelation: "service_offer_versions"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      client_contact_details: {
        Row: {
          address: string | null
          client_id: string
          email: string | null
          facebook: string | null
          instagram: string | null
          logo_path: string | null
          notes: string | null
          phone: string | null
          primary_contact: string | null
          role_title: string | null
          updated_at: string
          website: string | null
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          client_id: string
          email?: string | null
          facebook?: string | null
          instagram?: string | null
          logo_path?: string | null
          notes?: string | null
          phone?: string | null
          primary_contact?: string | null
          role_title?: string | null
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          client_id?: string
          email?: string | null
          facebook?: string | null
          instagram?: string | null
          logo_path?: string | null
          notes?: string | null
          phone?: string | null
          primary_contact?: string | null
          role_title?: string | null
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_contact_details_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_contact_details_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_content_pillars: {
        Row: {
          active: boolean
          belongs: string
          client_id: string
          created_at: string
          does_not_belong: string
          id: string
          name: string
          premise: string
          slug: string
          target_share: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          belongs: string
          client_id: string
          created_at?: string
          does_not_belong: string
          id?: string
          name: string
          premise: string
          slug: string
          target_share?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          belongs?: string
          client_id?: string
          created_at?: string
          does_not_belong?: string
          id?: string
          name?: string
          premise?: string
          slug?: string
          target_share?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_content_pillars_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_content_pillars_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_contracts: {
        Row: {
          client_id: string
          created_at: string
          id: string
          signed_at: string | null
          storage_path: string
          title: string
          uploaded_by: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          signed_at?: string | null
          storage_path: string
          title: string
          uploaded_by?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          signed_at?: string | null
          storage_path?: string
          title?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_contracts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_contracts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_contracts_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_daily_package_settings: {
        Row: {
          approval_cutoff: string
          campaign_id: string
          client_id: string
          enabled: boolean
          pillar_id: string
          platform: Database["public"]["Enums"]["post_platform"]
          story_media_type: Database["public"]["Enums"]["media_type"]
          updated_at: string
        }
        Insert: {
          approval_cutoff?: string
          campaign_id: string
          client_id: string
          enabled?: boolean
          pillar_id: string
          platform?: Database["public"]["Enums"]["post_platform"]
          story_media_type?: Database["public"]["Enums"]["media_type"]
          updated_at?: string
        }
        Update: {
          approval_cutoff?: string
          campaign_id?: string
          client_id?: string
          enabled?: boolean
          pillar_id?: string
          platform?: Database["public"]["Enums"]["post_platform"]
          story_media_type?: Database["public"]["Enums"]["media_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_daily_package_settings_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_daily_package_settings_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_daily_package_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_daily_package_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_daily_package_settings_pillar_id_fkey"
            columns: ["pillar_id"]
            isOneToOne: false
            referencedRelation: "client_content_pillars"
            referencedColumns: ["id"]
          },
        ]
      }
      client_engine_budgets: {
        Row: {
          cap_usd: number
          client_id: string
          created_at: string
          month: string
          note: string | null
          updated_at: string
        }
        Insert: {
          cap_usd: number
          client_id: string
          created_at?: string
          month: string
          note?: string | null
          updated_at?: string
        }
        Update: {
          cap_usd?: number
          client_id?: string
          created_at?: string
          month?: string
          note?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_engine_budgets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_engine_budgets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_engine_platforms: {
        Row: {
          active: boolean
          client_id: string
          created_at: string
          platform: Database["public"]["Enums"]["post_platform"]
          posts_per_week: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          client_id: string
          created_at?: string
          platform: Database["public"]["Enums"]["post_platform"]
          posts_per_week?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          client_id?: string
          created_at?: string
          platform?: Database["public"]["Enums"]["post_platform"]
          posts_per_week?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_engine_platforms_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_engine_platforms_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_engine_settings: {
        Row: {
          approval_mode: string
          auto_approve_briefs: boolean
          auto_approve_ideas: boolean
          client_id: string
          created_at: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          format_mix: Json
          max_jobs_in_flight: number
          min_qa_score: number
          plan_horizon_days: number
          proof_publishing_enabled: boolean
          proof_publishing_enabled_at: string | null
          proof_publishing_enabled_by: string | null
          publishing_enabled: boolean
          publishing_enabled_at: string | null
          publishing_enabled_by: string | null
          updated_at: string
        }
        Insert: {
          approval_mode?: string
          auto_approve_briefs?: boolean
          auto_approve_ideas?: boolean
          client_id: string
          created_at?: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
          format_mix?: Json
          max_jobs_in_flight?: number
          min_qa_score?: number
          plan_horizon_days?: number
          proof_publishing_enabled?: boolean
          proof_publishing_enabled_at?: string | null
          proof_publishing_enabled_by?: string | null
          publishing_enabled?: boolean
          publishing_enabled_at?: string | null
          publishing_enabled_by?: string | null
          updated_at?: string
        }
        Update: {
          approval_mode?: string
          auto_approve_briefs?: boolean
          auto_approve_ideas?: boolean
          client_id?: string
          created_at?: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
          format_mix?: Json
          max_jobs_in_flight?: number
          min_qa_score?: number
          plan_horizon_days?: number
          proof_publishing_enabled?: boolean
          proof_publishing_enabled_at?: string | null
          proof_publishing_enabled_by?: string | null
          publishing_enabled?: boolean
          publishing_enabled_at?: string | null
          publishing_enabled_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_engine_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_engine_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_engine_settings_proof_publishing_enabled_by_fkey"
            columns: ["proof_publishing_enabled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_engine_windows: {
        Row: {
          client_id: string
          created_at: string
          ends_at: string
          id: string
          platform: Database["public"]["Enums"]["post_platform"] | null
          starts_at: string
          weekday: number
        }
        Insert: {
          client_id: string
          created_at?: string
          ends_at: string
          id?: string
          platform?: Database["public"]["Enums"]["post_platform"] | null
          starts_at: string
          weekday: number
        }
        Update: {
          client_id?: string
          created_at?: string
          ends_at?: string
          id?: string
          platform?: Database["public"]["Enums"]["post_platform"] | null
          starts_at?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "client_engine_windows_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_engine_windows_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_ideas: {
        Row: {
          archived_at: string | null
          body: string | null
          campaign_id: string | null
          campaign_position: number | null
          client_id: string
          content_format: Database["public"]["Enums"]["content_format"]
          content_territory: string | null
          created_at: string
          created_by: string | null
          id: string
          job_id: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          pillar_id: string | null
          proof_id: string | null
          slot_id: string | null
          source: Database["public"]["Enums"]["idea_source"]
          source_question: string | null
          status: Database["public"]["Enums"]["idea_status"]
          strategic_reason: string | null
          target_platform: Database["public"]["Enums"]["post_platform"] | null
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          body?: string | null
          campaign_id?: string | null
          campaign_position?: number | null
          client_id: string
          content_format?: Database["public"]["Enums"]["content_format"]
          content_territory?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          pillar_id?: string | null
          proof_id?: string | null
          slot_id?: string | null
          source: Database["public"]["Enums"]["idea_source"]
          source_question?: string | null
          status?: Database["public"]["Enums"]["idea_status"]
          strategic_reason?: string | null
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          body?: string | null
          campaign_id?: string | null
          campaign_position?: number | null
          client_id?: string
          content_format?: Database["public"]["Enums"]["content_format"]
          content_territory?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          pillar_id?: string | null
          proof_id?: string | null
          slot_id?: string | null
          source?: Database["public"]["Enums"]["idea_source"]
          source_question?: string | null
          status?: Database["public"]["Enums"]["idea_status"]
          strategic_reason?: string | null
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_ideas_campaign_client_fkey"
            columns: ["campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "client_ideas_campaign_client_fkey"
            columns: ["campaign_id", "client_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "client_ideas_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_ideas_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_ideas_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_ideas_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_ideas_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_ideas_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_ideas_pillar_id_fkey"
            columns: ["pillar_id"]
            isOneToOne: false
            referencedRelation: "client_content_pillars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_ideas_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_ideas_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "client_ideas_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "client_ideas_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "content_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_ideas_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slot_board"
            referencedColumns: ["slot_id"]
          },
        ]
      }
      client_integrations: {
        Row: {
          access_level: string | null
          ad_account_id: string | null
          client_id: string
          created_at: string
          credential_label: string | null
          credential_secret_id: string | null
          health_detail: string | null
          id: string
          ingest_enabled: boolean
          last_checked_at: string | null
          meta_page_id: string | null
          meta_pixel_id: string | null
          provider: string
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_level?: string | null
          ad_account_id?: string | null
          client_id: string
          created_at?: string
          credential_label?: string | null
          credential_secret_id?: string | null
          health_detail?: string | null
          id?: string
          ingest_enabled?: boolean
          last_checked_at?: string | null
          meta_page_id?: string | null
          meta_pixel_id?: string | null
          provider: string
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_level?: string | null
          ad_account_id?: string | null
          client_id?: string
          created_at?: string
          credential_label?: string | null
          credential_secret_id?: string | null
          health_detail?: string | null
          id?: string
          ingest_enabled?: boolean
          last_checked_at?: string | null
          meta_page_id?: string | null
          meta_pixel_id?: string | null
          provider?: string
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_integrations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_integrations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_launch_asset_checks: {
        Row: {
          asset_id: string
          checked_at: string
          package_id: string
          qa_evidence: Json
        }
        Insert: {
          asset_id: string
          checked_at?: string
          package_id: string
          qa_evidence: Json
        }
        Update: {
          asset_id?: string
          checked_at?: string
          package_id?: string
          qa_evidence?: Json
        }
        Relationships: [
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_launch_asset_checks_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "client_launch_packages"
            referencedColumns: ["id"]
          },
        ]
      }
      client_launch_checks: {
        Row: {
          blocker: string | null
          check_key: string
          checked_at: string | null
          evidence: Json
          package_id: string
          record_id: string | null
          status: string
        }
        Insert: {
          blocker?: string | null
          check_key: string
          checked_at?: string | null
          evidence?: Json
          package_id: string
          record_id?: string | null
          status: string
        }
        Update: {
          blocker?: string | null
          check_key?: string
          checked_at?: string | null
          evidence?: Json
          package_id?: string
          record_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_launch_checks_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "client_launch_packages"
            referencedColumns: ["id"]
          },
        ]
      }
      client_launch_packages: {
        Row: {
          campaign_id: string
          client_id: string
          created_at: string
          id: string
          input_snapshot: Json
          run_id: string
        }
        Insert: {
          campaign_id: string
          client_id: string
          created_at?: string
          id?: string
          input_snapshot: Json
          run_id: string
        }
        Update: {
          campaign_id?: string
          client_id?: string
          created_at?: string
          id?: string
          input_snapshot?: Json
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_launch_packages_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_launch_packages_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_launch_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_launch_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_launch_packages_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      client_leads: {
        Row: {
          appointment_at: string | null
          appointment_outcome: string | null
          cash_collected: number | null
          client_id: string
          contact: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          lost_reason: string | null
          name: string | null
          next_action: string | null
          next_action_due: string | null
          notes: string | null
          opportunity_value: number | null
          owner_member_id: string | null
          phone: string | null
          pipeline_stage: Database["public"]["Enums"]["pipeline_stage"]
          sale_value: number | null
          source: string | null
          source_asset_id: string | null
          source_campaign_id: string | null
          source_channel: string | null
          source_page_id: string | null
          source_post_id: string | null
          source_sales_agent_id: string | null
          stage: Database["public"]["Enums"]["lead_stage"]
          stage_at: string
          updated_at: string
        }
        Insert: {
          appointment_at?: string | null
          appointment_outcome?: string | null
          cash_collected?: number | null
          client_id: string
          contact?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          lost_reason?: string | null
          name?: string | null
          next_action?: string | null
          next_action_due?: string | null
          notes?: string | null
          opportunity_value?: number | null
          owner_member_id?: string | null
          phone?: string | null
          pipeline_stage?: Database["public"]["Enums"]["pipeline_stage"]
          sale_value?: number | null
          source?: string | null
          source_asset_id?: string | null
          source_campaign_id?: string | null
          source_channel?: string | null
          source_page_id?: string | null
          source_post_id?: string | null
          source_sales_agent_id?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"]
          stage_at?: string
          updated_at?: string
        }
        Update: {
          appointment_at?: string | null
          appointment_outcome?: string | null
          cash_collected?: number | null
          client_id?: string
          contact?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          lost_reason?: string | null
          name?: string | null
          next_action?: string | null
          next_action_due?: string | null
          notes?: string | null
          opportunity_value?: number | null
          owner_member_id?: string | null
          phone?: string | null
          pipeline_stage?: Database["public"]["Enums"]["pipeline_stage"]
          sale_value?: number | null
          source?: string | null
          source_asset_id?: string | null
          source_campaign_id?: string | null
          source_channel?: string | null
          source_page_id?: string | null
          source_post_id?: string | null
          source_sales_agent_id?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"]
          stage_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_leads_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_owner_member_id_fkey"
            columns: ["owner_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_leads_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_campaign_id_fkey"
            columns: ["source_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_page_id_fkey"
            columns: ["source_page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_page_id_fkey"
            columns: ["source_page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_post_id_fkey"
            columns: ["source_post_id"]
            isOneToOne: false
            referencedRelation: "distribution_due"
            referencedColumns: ["schedule_id"]
          },
          {
            foreignKeyName: "client_leads_source_post_id_fkey"
            columns: ["source_post_id"]
            isOneToOne: false
            referencedRelation: "post_copy_effective"
            referencedColumns: ["scheduled_post_id"]
          },
          {
            foreignKeyName: "client_leads_source_post_id_fkey"
            columns: ["source_post_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["post_id"]
          },
          {
            foreignKeyName: "client_leads_source_post_id_fkey"
            columns: ["source_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_sales_agent_id_fkey"
            columns: ["source_sales_agent_id"]
            isOneToOne: false
            referencedRelation: "client_sales_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_source_sales_agent_id_fkey"
            columns: ["source_sales_agent_id"]
            isOneToOne: false
            referencedRelation: "sales_agents_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      client_marketing_spend: {
        Row: {
          amount: number
          campaign_id: string | null
          channel: string | null
          client_campaign_id: string | null
          client_id: string
          created_at: string
          created_by: string | null
          currency: string
          description: string | null
          external_ref: string | null
          id: string
          source: string
          spent_on: string
          updated_at: string
        }
        Insert: {
          amount: number
          campaign_id?: string | null
          channel?: string | null
          client_campaign_id?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          description?: string | null
          external_ref?: string | null
          id?: string
          source?: string
          spent_on: string
          updated_at?: string
        }
        Update: {
          amount?: number
          campaign_id?: string | null
          channel?: string | null
          client_campaign_id?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          description?: string | null
          external_ref?: string | null
          id?: string
          source?: string
          spent_on?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_marketing_spend_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_marketing_spend_client_campaign_id_fkey"
            columns: ["client_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_marketing_spend_client_campaign_id_fkey"
            columns: ["client_campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_marketing_spend_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_marketing_spend_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_marketing_spend_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_media_assets: {
        Row: {
          ad_cta: string | null
          ad_description: string | null
          ad_headline: string | null
          ad_link_url: string | null
          ad_primary_text: string | null
          archived_at: string | null
          brief_id: string | null
          client_id: string
          content_format: Database["public"]["Enums"]["content_format"]
          created_at: string
          duration_sec: number | null
          edit_plan: Json | null
          edit_stage: string
          height: number | null
          human_approved_at: string | null
          id: string
          intake_notes: string | null
          intake_source: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          member_id: string | null
          meta_ad_id: string | null
          meta_creative_id: string | null
          meta_image_hash: string | null
          purpose: Database["public"]["Enums"]["content_purpose"]
          ref_number: string | null
          render_path: string | null
          review_status: Database["public"]["Enums"]["review_status"]
          source_asset_id: string | null
          storage_path: string
          title: string | null
          updated_at: string
          uploaded_by: string | null
          usage_rights: string | null
          width: number | null
        }
        Insert: {
          ad_cta?: string | null
          ad_description?: string | null
          ad_headline?: string | null
          ad_link_url?: string | null
          ad_primary_text?: string | null
          archived_at?: string | null
          brief_id?: string | null
          client_id: string
          content_format?: Database["public"]["Enums"]["content_format"]
          created_at?: string
          duration_sec?: number | null
          edit_plan?: Json | null
          edit_stage?: string
          height?: number | null
          human_approved_at?: string | null
          id?: string
          intake_notes?: string | null
          intake_source?: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          member_id?: string | null
          meta_ad_id?: string | null
          meta_creative_id?: string | null
          meta_image_hash?: string | null
          purpose?: Database["public"]["Enums"]["content_purpose"]
          ref_number?: string | null
          render_path?: string | null
          review_status?: Database["public"]["Enums"]["review_status"]
          source_asset_id?: string | null
          storage_path: string
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          usage_rights?: string | null
          width?: number | null
        }
        Update: {
          ad_cta?: string | null
          ad_description?: string | null
          ad_headline?: string | null
          ad_link_url?: string | null
          ad_primary_text?: string | null
          archived_at?: string | null
          brief_id?: string | null
          client_id?: string
          content_format?: Database["public"]["Enums"]["content_format"]
          created_at?: string
          duration_sec?: number | null
          edit_plan?: Json | null
          edit_stage?: string
          height?: number | null
          human_approved_at?: string | null
          id?: string
          intake_notes?: string | null
          intake_source?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          member_id?: string | null
          meta_ad_id?: string | null
          meta_creative_id?: string | null
          meta_image_hash?: string | null
          purpose?: Database["public"]["Enums"]["content_purpose"]
          ref_number?: string | null
          render_path?: string | null
          review_status?: Database["public"]["Enums"]["review_status"]
          source_asset_id?: string | null
          storage_path?: string
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          usage_rights?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_media_assets_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "client_media_assets_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_media_assets_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_assets_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_media_frames: {
        Row: {
          asset_id: string
          beat: string | null
          caption: string | null
          clip_path: string | null
          created_at: string
          duration_sec: number | null
          id: string
          motion_preset: string | null
          position: number
          proof_asset_id: string | null
          provider_job_id: string | null
          provider_prior_job_ids: string[]
          provider_retry_count: number
          shot_source_kind: string | null
          storage_path: string
        }
        Insert: {
          asset_id: string
          beat?: string | null
          caption?: string | null
          clip_path?: string | null
          created_at?: string
          duration_sec?: number | null
          id?: string
          motion_preset?: string | null
          position: number
          proof_asset_id?: string | null
          provider_job_id?: string | null
          provider_prior_job_ids?: string[]
          provider_retry_count?: number
          shot_source_kind?: string | null
          storage_path: string
        }
        Update: {
          asset_id?: string
          beat?: string | null
          caption?: string | null
          clip_path?: string | null
          created_at?: string
          duration_sec?: number | null
          id?: string
          motion_preset?: string | null
          position?: number
          proof_asset_id?: string | null
          provider_job_id?: string | null
          provider_prior_job_ids?: string[]
          provider_retry_count?: number
          shot_source_kind?: string | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_media_frames_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_frames_proof_asset_id_fkey"
            columns: ["proof_asset_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      client_onboarding_steps: {
        Row: {
          client_id: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          display_order: number
          id: string
          status: Database["public"]["Enums"]["step_status"]
          step_key: string
          title: string
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          display_order?: number
          id?: string
          status?: Database["public"]["Enums"]["step_status"]
          step_key: string
          title: string
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          display_order?: number
          id?: string
          status?: Database["public"]["Enums"]["step_status"]
          step_key?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_onboarding_steps_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_onboarding_steps_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_onboarding_steps_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_page_findings: {
        Row: {
          category: string
          classification: string
          client_id: string
          created_at: string
          explanation: string
          id: string
          job_id: string | null
          page_id: string
          revision_number: number
          severity: string
          status: string
          suggested_direction: string | null
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          classification: string
          client_id: string
          created_at?: string
          explanation: string
          id?: string
          job_id?: string | null
          page_id: string
          revision_number: number
          severity?: string
          status?: string
          suggested_direction?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          classification?: string
          client_id?: string
          created_at?: string
          explanation?: string
          id?: string
          job_id?: string | null
          page_id?: string
          revision_number?: number
          severity?: string
          status?: string
          suggested_direction?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_page_findings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_findings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_page_findings_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_findings_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_page_findings_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_page_findings_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_findings_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      client_page_revisions: {
        Row: {
          body: string | null
          client_id: string
          created_at: string
          created_by: string | null
          html: string
          id: string
          job_id: string | null
          meta_description: string | null
          meta_title: string | null
          page_id: string
          reason: string | null
          revision_number: number
          source: string
          summary: string | null
        }
        Insert: {
          body?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          html: string
          id?: string
          job_id?: string | null
          meta_description?: string | null
          meta_title?: string | null
          page_id: string
          reason?: string | null
          revision_number: number
          source: string
          summary?: string | null
        }
        Update: {
          body?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          html?: string
          id?: string
          job_id?: string | null
          meta_description?: string | null
          meta_title?: string | null
          page_id?: string
          reason?: string | null
          revision_number?: number
          source?: string
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_page_revisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_revisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_page_revisions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_revisions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_revisions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_page_revisions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_page_revisions_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_page_revisions_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      client_pages: {
        Row: {
          archived_at: string | null
          body: string | null
          brief: string | null
          built_at: string | null
          client_id: string
          created_at: string
          created_by: string | null
          current_revision: number | null
          html: string | null
          id: string
          job_id: string | null
          meta_description: string | null
          meta_title: string | null
          page_type: Database["public"]["Enums"]["page_type"]
          publish_error: string | null
          publish_status: string
          published_at: string | null
          published_commit: string | null
          published_url: string | null
          reference_asset_id: string | null
          site_path: string | null
          site_repository_id: string | null
          status: Database["public"]["Enums"]["record_status"]
          thumbnail_path: string | null
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          body?: string | null
          brief?: string | null
          built_at?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          current_revision?: number | null
          html?: string | null
          id?: string
          job_id?: string | null
          meta_description?: string | null
          meta_title?: string | null
          page_type: Database["public"]["Enums"]["page_type"]
          publish_error?: string | null
          publish_status?: string
          published_at?: string | null
          published_commit?: string | null
          published_url?: string | null
          reference_asset_id?: string | null
          site_path?: string | null
          site_repository_id?: string | null
          status?: Database["public"]["Enums"]["record_status"]
          thumbnail_path?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          body?: string | null
          brief?: string | null
          built_at?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          current_revision?: number | null
          html?: string | null
          id?: string
          job_id?: string | null
          meta_description?: string | null
          meta_title?: string | null
          page_type?: Database["public"]["Enums"]["page_type"]
          publish_error?: string | null
          publish_status?: string
          published_at?: string | null
          published_commit?: string | null
          published_url?: string | null
          reference_asset_id?: string | null
          site_path?: string | null
          site_repository_id?: string | null
          status?: Database["public"]["Enums"]["record_status"]
          thumbnail_path?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_pages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_pages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_pages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_pages_reference_asset_id_fkey"
            columns: ["reference_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_site_repository_id_fkey"
            columns: ["site_repository_id"]
            isOneToOne: false
            referencedRelation: "client_site_repositories"
            referencedColumns: ["id"]
          },
        ]
      }
      client_proof_assets: {
        Row: {
          avatar_relevance: string | null
          body: string | null
          capture_file_mime: string | null
          capture_method: string | null
          captured_on: string | null
          claim: string | null
          client_id: string
          created_at: string
          evidence: string | null
          expires_on: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          permission_basis: string | null
          proof_type: string | null
          ref_number: string | null
          services: string | null
          source: string | null
          source_category: string | null
          source_format: Database["public"]["Enums"]["content_format"]
          source_kind: string | null
          storage_path: string | null
          strength: string
          title: string | null
          updated_at: string
          uploaded_by: string | null
          usage_rights: string
        }
        Insert: {
          avatar_relevance?: string | null
          body?: string | null
          capture_file_mime?: string | null
          capture_method?: string | null
          captured_on?: string | null
          claim?: string | null
          client_id: string
          created_at?: string
          evidence?: string | null
          expires_on?: string | null
          id?: string
          media_type: Database["public"]["Enums"]["media_type"]
          permission_basis?: string | null
          proof_type?: string | null
          ref_number?: string | null
          services?: string | null
          source?: string | null
          source_category?: string | null
          source_format?: Database["public"]["Enums"]["content_format"]
          source_kind?: string | null
          storage_path?: string | null
          strength?: string
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          usage_rights?: string
        }
        Update: {
          avatar_relevance?: string | null
          body?: string | null
          capture_file_mime?: string | null
          capture_method?: string | null
          captured_on?: string | null
          claim?: string | null
          client_id?: string
          created_at?: string
          evidence?: string | null
          expires_on?: string | null
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          permission_basis?: string | null
          proof_type?: string | null
          ref_number?: string | null
          services?: string | null
          source?: string | null
          source_category?: string | null
          source_format?: Database["public"]["Enums"]["content_format"]
          source_kind?: string | null
          storage_path?: string | null
          strength?: string
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          usage_rights?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_proof_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_proof_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_proof_assets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_proof_destinations: {
        Row: {
          account_ref: string | null
          client_id: string
          destination_key: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
        }
        Insert: {
          account_ref?: string | null
          client_id: string
          destination_key: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
        }
        Update: {
          account_ref?: string | null
          client_id?: string
          destination_key?: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_proof_destinations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_proof_destinations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_proof_destinations_destination_key_fkey"
            columns: ["destination_key"]
            isOneToOne: false
            referencedRelation: "proof_destinations"
            referencedColumns: ["destination_key"]
          },
          {
            foreignKeyName: "client_proof_destinations_enabled_by_fkey"
            columns: ["enabled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_sales_agent_deployments: {
        Row: {
          allowed_origin: string
          client_id: string
          created_at: string
          daily_cost_limit_usd: number
          daily_message_limit: number
          deployed_at: string | null
          disabled_at: string | null
          enabled: boolean
          id: string
          page_id: string
          public_id: string
          sales_agent_id: string
          site_repository_id: string | null
          updated_at: string
          widget_config: Json
        }
        Insert: {
          allowed_origin: string
          client_id: string
          created_at?: string
          daily_cost_limit_usd?: number
          daily_message_limit?: number
          deployed_at?: string | null
          disabled_at?: string | null
          enabled?: boolean
          id?: string
          page_id: string
          public_id?: string
          sales_agent_id: string
          site_repository_id?: string | null
          updated_at?: string
          widget_config?: Json
        }
        Update: {
          allowed_origin?: string
          client_id?: string
          created_at?: string
          daily_cost_limit_usd?: number
          daily_message_limit?: number
          deployed_at?: string | null
          disabled_at?: string | null
          enabled?: boolean
          id?: string
          page_id?: string
          public_id?: string
          sales_agent_id?: string
          site_repository_id?: string | null
          updated_at?: string
          widget_config?: Json
        }
        Relationships: [
          {
            foreignKeyName: "client_sales_agent_deployments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agent_deployments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_sales_agent_deployments_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agent_deployments_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agent_deployments_sales_agent_id_fkey"
            columns: ["sales_agent_id"]
            isOneToOne: false
            referencedRelation: "client_sales_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agent_deployments_sales_agent_id_fkey"
            columns: ["sales_agent_id"]
            isOneToOne: false
            referencedRelation: "sales_agents_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agent_deployments_site_repository_id_fkey"
            columns: ["site_repository_id"]
            isOneToOne: false
            referencedRelation: "client_site_repositories"
            referencedColumns: ["id"]
          },
        ]
      }
      client_sales_agents: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          archived_at: string | null
          booking_rule: string | null
          built_at: string | null
          client_id: string
          created_at: string
          escalation_rule: string | null
          greeting: string | null
          guardrails: string | null
          id: string
          job_id: string | null
          name: string
          objections: Json
          page_id: string | null
          purpose: string
          qualification: Json
          role: string | null
          status: string
          system_prompt: string | null
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          booking_rule?: string | null
          built_at?: string | null
          client_id: string
          created_at?: string
          escalation_rule?: string | null
          greeting?: string | null
          guardrails?: string | null
          id?: string
          job_id?: string | null
          name: string
          objections?: Json
          page_id?: string | null
          purpose: string
          qualification?: Json
          role?: string | null
          status?: string
          system_prompt?: string | null
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          booking_rule?: string | null
          built_at?: string | null
          client_id?: string
          created_at?: string
          escalation_rule?: string | null
          greeting?: string | null
          guardrails?: string | null
          id?: string
          job_id?: string | null
          name?: string
          objections?: Json
          page_id?: string | null
          purpose?: string
          qualification?: Json
          role?: string | null
          status?: string
          system_prompt?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_sales_agents_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_sales_agents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_sales_agents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "client_sales_agents_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agents_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      client_site_repositories: {
        Row: {
          client_id: string
          created_at: string
          custom_domain: string | null
          default_branch: string
          github_repository_id: number | null
          id: string
          installation_id: string
          last_error: string | null
          owner: string
          pages_path: string
          pages_url: string | null
          provisioned_at: string | null
          repo: string
          status: string
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          custom_domain?: string | null
          default_branch?: string
          github_repository_id?: number | null
          id?: string
          installation_id: string
          last_error?: string | null
          owner: string
          pages_path?: string
          pages_url?: string | null
          provisioned_at?: string | null
          repo: string
          status?: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          custom_domain?: string | null
          default_branch?: string
          github_repository_id?: number | null
          id?: string
          installation_id?: string
          last_error?: string | null
          owner?: string
          pages_path?: string
          pages_url?: string | null
          provisioned_at?: string | null
          repo?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_site_repositories_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_repositories_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_site_repositories_installation_id_fkey"
            columns: ["installation_id"]
            isOneToOne: false
            referencedRelation: "github_app_installations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_users: {
        Row: {
          client_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          created_at: string
          id: string
          initials: string
          is_internal: boolean
          location: string | null
          name: string
          sector: string | null
          tier: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          initials: string
          is_internal?: boolean
          location?: string | null
          name: string
          sector?: string | null
          tier?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          initials?: string
          is_internal?: boolean
          location?: string | null
          name?: string
          sector?: string | null
          tier?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      content_approval_settings: {
        Row: {
          owner_user_id: string
          singleton: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          owner_user_id: string
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          owner_user_id?: string
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_approval_settings_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_approval_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      content_slots: {
        Row: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          attempts?: number
          blocked_reason?: string | null
          brief_id?: string | null
          client_id: string
          cost_usd?: number
          created_at?: string
          format?: Database["public"]["Enums"]["content_format"]
          id?: string
          idea_id?: string | null
          pillar_id?: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at?: string | null
          qa_findings?: Json
          qa_score?: number | null
          scheduled_at: string
          scheduled_post_id?: string | null
          stage?: Database["public"]["Enums"]["slot_stage"]
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          attempts?: number
          blocked_reason?: string | null
          brief_id?: string | null
          client_id?: string
          cost_usd?: number
          created_at?: string
          format?: Database["public"]["Enums"]["content_format"]
          id?: string
          idea_id?: string | null
          pillar_id?: string | null
          platform?: Database["public"]["Enums"]["post_platform"]
          qa_checked_at?: string | null
          qa_findings?: Json
          qa_score?: number | null
          scheduled_at?: string
          scheduled_post_id?: string | null
          stage?: Database["public"]["Enums"]["slot_stage"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "content_slots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "content_slots_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "content_slots_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
          {
            foreignKeyName: "content_slots_pillar_id_fkey"
            columns: ["pillar_id"]
            isOneToOne: false
            referencedRelation: "client_content_pillars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "distribution_due"
            referencedColumns: ["schedule_id"]
          },
          {
            foreignKeyName: "content_slots_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "post_copy_effective"
            referencedColumns: ["scheduled_post_id"]
          },
          {
            foreignKeyName: "content_slots_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["post_id"]
          },
          {
            foreignKeyName: "content_slots_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_payments: {
        Row: {
          compensation: number
          created_at: string
          due_date: string | null
          id: string
          member_id: string
          payment_date: string | null
          service_rendered: string
          updated_at: string
        }
        Insert: {
          compensation: number
          created_at?: string
          due_date?: string | null
          id?: string
          member_id: string
          payment_date?: string | null
          service_rendered: string
          updated_at?: string
        }
        Update: {
          compensation?: number
          created_at?: string
          due_date?: string | null
          id?: string
          member_id?: string
          payment_date?: string | null
          service_rendered?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_payments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      creative_generations: {
        Row: {
          asset_id: string | null
          brief_id: string
          client_id: string
          concept: Json | null
          concept_edited_at: string | null
          concept_model: string | null
          cost_usd: number | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          image_model: string | null
          image_prompt: string | null
          job_id: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          quality: string
          reference_path: string | null
          remake_feedback: string | null
          size: string
          stage: Database["public"]["Enums"]["creative_stage"]
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          brief_id: string
          client_id: string
          concept?: Json | null
          concept_edited_at?: string | null
          concept_model?: string | null
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          image_model?: string | null
          image_prompt?: string | null
          job_id?: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          quality?: string
          reference_path?: string | null
          remake_feedback?: string | null
          size?: string
          stage?: Database["public"]["Enums"]["creative_stage"]
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          brief_id?: string
          client_id?: string
          concept?: Json | null
          concept_edited_at?: string | null
          concept_model?: string | null
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          image_model?: string | null
          image_prompt?: string | null
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          quality?: string
          reference_path?: string | null
          remake_feedback?: string | null
          size?: string
          stage?: Database["public"]["Enums"]["creative_stage"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_generations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "creative_generations_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "creative_generations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "creative_generations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "creative_generations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      creative_renders: {
        Row: {
          asset_id: string | null
          client_id: string
          cost_usd: number | null
          created_at: string
          created_by: string | null
          error: string | null
          generation_id: string
          id: string
          job_id: string | null
          model: string | null
          quality: string
          reference_path: string | null
          selected: boolean
          size: string
          status: Database["public"]["Enums"]["render_status"]
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          client_id: string
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          generation_id: string
          id?: string
          job_id?: string | null
          model?: string | null
          quality?: string
          reference_path?: string | null
          selected?: boolean
          size?: string
          status?: Database["public"]["Enums"]["render_status"]
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          client_id?: string
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          generation_id?: string
          id?: string
          job_id?: string | null
          model?: string | null
          quality?: string
          reference_path?: string | null
          selected?: boolean
          size?: string
          status?: Database["public"]["Enums"]["render_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "creative_renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_renders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_renders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "creative_renders_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "creative_generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_renders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_renders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "creative_renders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      daily_package_items: {
        Row: {
          asset_id: string | null
          campaign_id: string
          content_format: Database["public"]["Enums"]["content_format"]
          created_at: string
          final_step_id: string
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          package_id: string
          pillar_id: string
          proof_id: string | null
          role: string
          slot_id: string | null
        }
        Insert: {
          asset_id?: string | null
          campaign_id: string
          content_format: Database["public"]["Enums"]["content_format"]
          created_at?: string
          final_step_id: string
          id?: string
          media_type: Database["public"]["Enums"]["media_type"]
          package_id: string
          pillar_id: string
          proof_id?: string | null
          role: string
          slot_id?: string | null
        }
        Update: {
          asset_id?: string | null
          campaign_id?: string
          content_format?: Database["public"]["Enums"]["content_format"]
          created_at?: string
          final_step_id?: string
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          package_id?: string
          pillar_id?: string
          proof_id?: string | null
          role?: string
          slot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_final_step_id_fkey"
            columns: ["final_step_id"]
            isOneToOne: true
            referencedRelation: "workflow_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "daily_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_pillar_id_fkey"
            columns: ["pillar_id"]
            isOneToOne: false
            referencedRelation: "client_content_pillars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: true
            referencedRelation: "approval_inbox"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "daily_package_items_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: true
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "daily_package_items_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: true
            referencedRelation: "content_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_items_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: true
            referencedRelation: "slot_board"
            referencedColumns: ["slot_id"]
          },
        ]
      }
      daily_package_recoveries: {
        Row: {
          id: string
          item_id: string
          reason: string
          reserve_asset_id: string
          selected_at: string
        }
        Insert: {
          id?: string
          item_id: string
          reason: string
          reserve_asset_id: string
          selected_at?: string
        }
        Update: {
          id?: string
          item_id?: string
          reason?: string
          reserve_asset_id?: string
          selected_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_package_recoveries_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: true
            referencedRelation: "daily_package_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "daily_package_recoveries_reserve_asset_id_fkey"
            columns: ["reserve_asset_id"]
            isOneToOne: true
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_package_recovery_alerts: {
        Row: {
          created_at: string
          delivered_at: string | null
          delivery_attempts: number
          delivery_error: string | null
          delivery_lease_until: string | null
          delivery_status: string
          delivery_worker: string | null
          id: string
          item_id: string
          provider_message_id: string | null
          reason: string
          resolved_at: string | null
        }
        Insert: {
          created_at?: string
          delivered_at?: string | null
          delivery_attempts?: number
          delivery_error?: string | null
          delivery_lease_until?: string | null
          delivery_status?: string
          delivery_worker?: string | null
          id?: string
          item_id: string
          provider_message_id?: string | null
          reason: string
          resolved_at?: string | null
        }
        Update: {
          created_at?: string
          delivered_at?: string | null
          delivery_attempts?: number
          delivery_error?: string | null
          delivery_lease_until?: string | null
          delivery_status?: string
          delivery_worker?: string | null
          id?: string
          item_id?: string
          provider_message_id?: string | null
          reason?: string
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_package_recovery_alerts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "daily_package_items"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_packages: {
        Row: {
          client_id: string
          created_at: string
          cutoff_at: string
          id: string
          package_day: string
          platform: Database["public"]["Enums"]["post_platform"]
          run_id: string
          story_media_type: Database["public"]["Enums"]["media_type"]
        }
        Insert: {
          client_id: string
          created_at?: string
          cutoff_at: string
          id?: string
          package_day: string
          platform: Database["public"]["Enums"]["post_platform"]
          run_id: string
          story_media_type: Database["public"]["Enums"]["media_type"]
        }
        Update: {
          client_id?: string
          created_at?: string
          cutoff_at?: string
          id?: string
          package_day?: string
          platform?: Database["public"]["Enums"]["post_platform"]
          run_id?: string
          story_media_type?: Database["public"]["Enums"]["media_type"]
        }
        Relationships: [
          {
            foreignKeyName: "daily_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_packages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "daily_packages_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_controls: {
        Row: {
          enabled: boolean
          id: boolean
          note: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          id?: boolean
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          id?: boolean
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      engine_decisions: {
        Row: {
          brief_id: string | null
          client_id: string
          considered: Json
          decided_at: string
          id: string
          idea_id: string | null
          kind: string
          reasons: Json
          score: number | null
          slot_id: string
        }
        Insert: {
          brief_id?: string | null
          client_id: string
          considered?: Json
          decided_at?: string
          id?: string
          idea_id?: string | null
          kind: string
          reasons?: Json
          score?: number | null
          slot_id: string
        }
        Update: {
          brief_id?: string | null
          client_id?: string
          considered?: Json
          decided_at?: string
          id?: string
          idea_id?: string | null
          kind?: string
          reasons?: Json
          score?: number | null
          slot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "engine_decisions_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_decisions_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "engine_decisions_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "engine_decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "engine_decisions_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_decisions_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "content_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slot_board"
            referencedColumns: ["slot_id"]
          },
        ]
      }
      engine_tick_runs: {
        Row: {
          clients_considered: number
          clients_skipped: number
          finished_at: string | null
          id: string
          jobs_queued: number
          notes: Json
          slots_planned: number
          started_at: string
        }
        Insert: {
          clients_considered?: number
          clients_skipped?: number
          finished_at?: string | null
          id?: string
          jobs_queued?: number
          notes?: Json
          slots_planned?: number
          started_at?: string
        }
        Update: {
          clients_considered?: number
          clients_skipped?: number
          finished_at?: string | null
          id?: string
          jobs_queued?: number
          notes?: Json
          slots_planned?: number
          started_at?: string
        }
        Relationships: []
      }
      finance_entries: {
        Row: {
          amount: number
          category: string | null
          client_id: string | null
          created_at: string
          id: string
          line_item: string
          period: string
          statement: string
        }
        Insert: {
          amount: number
          category?: string | null
          client_id?: string | null
          created_at?: string
          id?: string
          line_item: string
          period: string
          statement: string
        }
        Update: {
          amount?: number
          category?: string | null
          client_id?: string | null
          created_at?: string
          id?: string
          line_item?: string
          period?: string
          statement?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      finance_periods: {
        Row: {
          cac: number | null
          created_at: string
          id: string
          ltv: number | null
          mrr: number | null
          notes: string | null
          period: string
          updated_at: string
        }
        Insert: {
          cac?: number | null
          created_at?: string
          id?: string
          ltv?: number | null
          mrr?: number | null
          notes?: string | null
          period: string
          updated_at?: string
        }
        Update: {
          cac?: number | null
          created_at?: string
          id?: string
          ltv?: number | null
          mrr?: number | null
          notes?: string | null
          period?: string
          updated_at?: string
        }
        Relationships: []
      }
      github_app_installations: {
        Row: {
          account_login: string
          account_type: string
          client_id: string | null
          connected_at: string
          created_at: string
          id: string
          installation_id: number
          last_checked_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account_login: string
          account_type?: string
          client_id?: string | null
          connected_at?: string
          created_at?: string
          id?: string
          installation_id: number
          last_checked_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          account_login?: string
          account_type?: string
          client_id?: string | null
          connected_at?: string
          created_at?: string
          id?: string
          installation_id?: number
          last_checked_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_app_installations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_app_installations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      ideation_learning_snapshots: {
        Row: {
          captured_at: string
          client_id: string
          evidence: Json
          job_id: string
        }
        Insert: {
          captured_at?: string
          client_id: string
          evidence: Json
          job_id: string
        }
        Update: {
          captured_at?: string
          client_id?: string
          evidence?: Json
          job_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ideation_learning_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ideation_learning_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "ideation_learning_snapshots_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ideation_learning_snapshots_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "ideation_learning_snapshots_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      job_assignments: {
        Row: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          asset_id?: string | null
          brief_id?: string | null
          client_id?: string | null
          compensation?: number | null
          completed_at?: string | null
          created_at?: string
          delivered_at?: string | null
          due_date?: string | null
          id?: string
          member_id: string
          source_asset_id?: string | null
          stage?: Database["public"]["Enums"]["assignment_stage"]
          stage_reason?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          asset_id?: string | null
          brief_id?: string | null
          client_id?: string | null
          compensation?: number | null
          completed_at?: string | null
          created_at?: string
          delivered_at?: string | null
          due_date?: string | null
          id?: string
          member_id?: string
          source_asset_id?: string | null
          stage?: Database["public"]["Enums"]["assignment_stage"]
          stage_reason?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "job_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "job_assignments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_events: {
        Row: {
          body: string | null
          client_id: string
          created_at: string
          created_by: string | null
          created_by_bot: string | null
          from_stage: Database["public"]["Enums"]["lead_stage"] | null
          id: string
          kind: string
          lead_id: string
          occurred_at: string
          to_stage: Database["public"]["Enums"]["lead_stage"] | null
        }
        Insert: {
          body?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          created_by_bot?: string | null
          from_stage?: Database["public"]["Enums"]["lead_stage"] | null
          id?: string
          kind: string
          lead_id: string
          occurred_at?: string
          to_stage?: Database["public"]["Enums"]["lead_stage"] | null
        }
        Update: {
          body?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          created_by_bot?: string | null
          from_stage?: Database["public"]["Enums"]["lead_stage"] | null
          id?: string
          kind?: string
          lead_id?: string
          occurred_at?: string
          to_stage?: Database["public"]["Enums"]["lead_stage"] | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "lead_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "client_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_progress"
            referencedColumns: ["lead_id"]
          },
        ]
      }
      lead_identities: {
        Row: {
          client_id: string
          id: string
        }
        Insert: {
          client_id: string
          id: string
        }
        Update: {
          client_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_identities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_identities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      market_opportunities: {
        Row: {
          buying_situation: string
          client_id: string
          confidence: Database["public"]["Enums"]["opportunity_confidence"]
          conversion_action: string | null
          core_problem: string | null
          created_at: string
          created_by: string | null
          desired_outcome: string | null
          entry_awareness: string | null
          id: string
          idempotency_key: string
          micro_market: string
          name: string
          positioning: string | null
          proposed_by: string
          proposed_by_job_id: string | null
          purchase_trigger: string | null
          status: Database["public"]["Enums"]["opportunity_status"]
          status_note: string | null
          updated_at: string
        }
        Insert: {
          buying_situation: string
          client_id: string
          confidence?: Database["public"]["Enums"]["opportunity_confidence"]
          conversion_action?: string | null
          core_problem?: string | null
          created_at?: string
          created_by?: string | null
          desired_outcome?: string | null
          entry_awareness?: string | null
          id?: string
          idempotency_key: string
          micro_market: string
          name: string
          positioning?: string | null
          proposed_by?: string
          proposed_by_job_id?: string | null
          purchase_trigger?: string | null
          status?: Database["public"]["Enums"]["opportunity_status"]
          status_note?: string | null
          updated_at?: string
        }
        Update: {
          buying_situation?: string
          client_id?: string
          confidence?: Database["public"]["Enums"]["opportunity_confidence"]
          conversion_action?: string | null
          core_problem?: string | null
          created_at?: string
          created_by?: string | null
          desired_outcome?: string | null
          entry_awareness?: string | null
          id?: string
          idempotency_key?: string
          micro_market?: string
          name?: string
          positioning?: string | null
          proposed_by?: string
          proposed_by_job_id?: string | null
          purchase_trigger?: string | null
          status?: Database["public"]["Enums"]["opportunity_status"]
          status_note?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "market_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "market_opportunities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "market_opportunities_proposed_by_job_id_fkey"
            columns: ["proposed_by_job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "market_opportunities_proposed_by_job_id_fkey"
            columns: ["proposed_by_job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "market_opportunities_proposed_by_job_id_fkey"
            columns: ["proposed_by_job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      master_ai_conversations: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string
          id: string
          pending_confirmation: Json | null
          scope: Database["public"]["Enums"]["master_ai_scope"]
          title: string | null
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by: string
          id?: string
          pending_confirmation?: Json | null
          scope: Database["public"]["Enums"]["master_ai_scope"]
          title?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          id?: string
          pending_confirmation?: Json | null
          scope?: Database["public"]["Enums"]["master_ai_scope"]
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_ai_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_ai_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      master_ai_messages: {
        Row: {
          content: string
          conversation_id: string
          cost_usd: number | null
          created_at: string
          id: string
          role: string
          tool_calls: Json
        }
        Insert: {
          content?: string
          conversation_id: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          role: string
          tool_calls?: Json
        }
        Update: {
          content?: string
          conversation_id?: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          role?: string
          tool_calls?: Json
        }
        Relationships: [
          {
            foreignKeyName: "master_ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "master_ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_bot_clients: {
        Row: {
          bot_id: string
          client_id: string
          created_at: string
          granted_at: string
          granted_by: string | null
        }
        Insert: {
          bot_id: string
          client_id: string
          created_at?: string
          granted_at?: string
          granted_by?: string | null
        }
        Update: {
          bot_id?: string
          client_id?: string
          created_at?: string
          granted_at?: string
          granted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mcp_bot_clients_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_bot_clients_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      mcp_brief_requests: {
        Row: {
          bot_id: string
          client_id: string
          created_at: string
          execution_id: string
          idea_id: string
          job_id: string
          request_id: string
        }
        Insert: {
          bot_id: string
          client_id: string
          created_at?: string
          execution_id: string
          idea_id: string
          job_id: string
          request_id: string
        }
        Update: {
          bot_id?: string
          client_id?: string
          created_at?: string
          execution_id?: string
          idea_id?: string
          job_id?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_brief_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_brief_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mcp_brief_requests_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_brief_requests_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
          {
            foreignKeyName: "mcp_brief_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_brief_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "mcp_brief_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      metrics_daily: {
        Row: {
          basis: Database["public"]["Enums"]["metric_basis"]
          campaign_id: string | null
          clicks: number | null
          client_id: string
          conversions: number | null
          currency: string | null
          engagements: number | null
          entity_type: Database["public"]["Enums"]["metric_entity"]
          external_id: string
          fetched_at: string
          id: string
          impressions: number | null
          metric_date: string
          post_id: string | null
          raw: Json | null
          reach: number | null
          spend: number | null
          surface: Database["public"]["Enums"]["metric_surface"]
        }
        Insert: {
          basis?: Database["public"]["Enums"]["metric_basis"]
          campaign_id?: string | null
          clicks?: number | null
          client_id: string
          conversions?: number | null
          currency?: string | null
          engagements?: number | null
          entity_type: Database["public"]["Enums"]["metric_entity"]
          external_id: string
          fetched_at?: string
          id?: string
          impressions?: number | null
          metric_date: string
          post_id?: string | null
          raw?: Json | null
          reach?: number | null
          spend?: number | null
          surface: Database["public"]["Enums"]["metric_surface"]
        }
        Update: {
          basis?: Database["public"]["Enums"]["metric_basis"]
          campaign_id?: string | null
          clicks?: number | null
          client_id?: string
          conversions?: number | null
          currency?: string | null
          engagements?: number | null
          entity_type?: Database["public"]["Enums"]["metric_entity"]
          external_id?: string
          fetched_at?: string
          id?: string
          impressions?: number | null
          metric_date?: string
          post_id?: string | null
          raw?: Json | null
          reach?: number | null
          spend?: number | null
          surface?: Database["public"]["Enums"]["metric_surface"]
        }
        Relationships: [
          {
            foreignKeyName: "metrics_daily_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_daily_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_daily_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "metrics_daily_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "distribution_due"
            referencedColumns: ["schedule_id"]
          },
          {
            foreignKeyName: "metrics_daily_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "post_copy_effective"
            referencedColumns: ["scheduled_post_id"]
          },
          {
            foreignKeyName: "metrics_daily_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["post_id"]
          },
          {
            foreignKeyName: "metrics_daily_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      motion_design_attachments: {
        Row: {
          asset_id: string
          brief_id: string | null
          created_at: string
          created_by: string | null
          destination: string
          id: string
          project_id: string
        }
        Insert: {
          asset_id: string
          brief_id?: string | null
          created_at?: string
          created_by?: string | null
          destination: string
          id?: string
          project_id: string
        }
        Update: {
          asset_id?: string
          brief_id?: string | null
          created_at?: string
          created_by?: string | null
          destination?: string
          id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "motion_design_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "motion_design_attachments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "motion_design_attachments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "motion_design_attachments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "motion_design_attachments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "motion_design_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      motion_design_projects: {
        Row: {
          aspect: string
          brand_mode: string
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          duration_sec: number
          error: string | null
          id: string
          job_id: string | null
          poster_path: string | null
          preset: string
          prompt: string
          render_path: string | null
          revision_of: string | null
          scene_plan: Json | null
          status: string
        }
        Insert: {
          aspect: string
          brand_mode: string
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          duration_sec: number
          error?: string | null
          id?: string
          job_id?: string | null
          poster_path?: string | null
          preset: string
          prompt: string
          render_path?: string | null
          revision_of?: string | null
          scene_plan?: Json | null
          status?: string
        }
        Update: {
          aspect?: string
          brand_mode?: string
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          duration_sec?: number
          error?: string | null
          id?: string
          job_id?: string | null
          poster_path?: string | null
          preset?: string
          prompt?: string
          render_path?: string | null
          revision_of?: string | null
          scene_plan?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "motion_design_projects_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "motion_design_projects_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "motion_design_projects_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "motion_design_projects_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "motion_design_projects_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "motion_design_projects_revision_of_fkey"
            columns: ["revision_of"]
            isOneToOne: false
            referencedRelation: "motion_design_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_attributes: {
        Row: {
          body: string
          client_id: string
          created_at: string
          id: string
          kind: string
          opportunity_id: string
          position: number
        }
        Insert: {
          body: string
          client_id: string
          created_at?: string
          id?: string
          kind: string
          opportunity_id: string
          position: number
        }
        Update: {
          body?: string
          client_id?: string
          created_at?: string
          id?: string
          kind?: string
          opportunity_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_attributes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_attributes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "opportunity_attributes_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "market_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_attributes_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunity_readiness"
            referencedColumns: ["opportunity_id"]
          },
        ]
      }
      opportunity_awareness_stages: {
        Row: {
          asset_direction: string | null
          client_id: string
          created_at: string
          distribution_note: string | null
          id: string
          message: string
          mindset: string
          opportunity_id: string
          stage: string
        }
        Insert: {
          asset_direction?: string | null
          client_id: string
          created_at?: string
          distribution_note?: string | null
          id?: string
          message: string
          mindset: string
          opportunity_id: string
          stage: string
        }
        Update: {
          asset_direction?: string | null
          client_id?: string
          created_at?: string
          distribution_note?: string | null
          id?: string
          message?: string
          mindset?: string
          opportunity_id?: string
          stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_awareness_stages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_awareness_stages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "opportunity_awareness_stages_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "market_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_awareness_stages_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunity_readiness"
            referencedColumns: ["opportunity_id"]
          },
        ]
      }
      opportunity_events: {
        Row: {
          actor: string
          client_id: string
          detail: string | null
          event: string
          id: string
          occurred_at: string
          opportunity_id: string
        }
        Insert: {
          actor: string
          client_id: string
          detail?: string | null
          event: string
          id?: string
          occurred_at?: string
          opportunity_id: string
        }
        Update: {
          actor?: string
          client_id?: string
          detail?: string | null
          event?: string
          id?: string
          occurred_at?: string
          opportunity_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "opportunity_events_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "market_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_events_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunity_readiness"
            referencedColumns: ["opportunity_id"]
          },
        ]
      }
      opportunity_links: {
        Row: {
          campaign_id: string | null
          client_id: string
          created_at: string
          id: string
          offer_id: string | null
          opportunity_id: string
          record_id: string | null
          role: string
        }
        Insert: {
          campaign_id?: string | null
          client_id: string
          created_at?: string
          id?: string
          offer_id?: string | null
          opportunity_id: string
          record_id?: string | null
          role: string
        }
        Update: {
          campaign_id?: string | null
          client_id?: string
          created_at?: string
          id?: string
          offer_id?: string | null
          opportunity_id?: string
          record_id?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_links_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_links_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_links_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_links_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "opportunity_links_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "service_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_links_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "market_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_links_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunity_readiness"
            referencedColumns: ["opportunity_id"]
          },
          {
            foreignKeyName: "opportunity_links_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "client_agent_records"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_proof_requirements: {
        Row: {
          client_id: string
          created_at: string
          id: string
          opportunity_id: string
          proof_id: string | null
          requirement: string
          satisfied_at: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          opportunity_id: string
          proof_id?: string | null
          requirement: string
          satisfied_at?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          opportunity_id?: string
          proof_id?: string | null
          requirement?: string
          satisfied_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_proof_requirements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_proof_requirements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "opportunity_proof_requirements_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "market_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_proof_requirements_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunity_readiness"
            referencedColumns: ["opportunity_id"]
          },
          {
            foreignKeyName: "opportunity_proof_requirements_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_score_factors: {
        Row: {
          factor: string
          label: string
          note: string
          weight: number
        }
        Insert: {
          factor: string
          label: string
          note: string
          weight: number
        }
        Update: {
          factor?: string
          label?: string
          note?: string
          weight?: number
        }
        Relationships: []
      }
      opportunity_scores: {
        Row: {
          classification: string
          client_id: string
          factors: Json
          id: string
          note: string | null
          opportunity_id: string
          scored_at: string
          scored_by: string | null
          total: number
        }
        Insert: {
          classification: string
          client_id: string
          factors: Json
          id?: string
          note?: string | null
          opportunity_id: string
          scored_at?: string
          scored_by?: string | null
          total: number
        }
        Update: {
          classification?: string
          client_id?: string
          factors?: Json
          id?: string
          note?: string | null
          opportunity_id?: string
          scored_at?: string
          scored_by?: string | null
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_scores_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_scores_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "opportunity_scores_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "market_opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_scores_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunity_readiness"
            referencedColumns: ["opportunity_id"]
          },
          {
            foreignKeyName: "opportunity_scores_scored_by_fkey"
            columns: ["scored_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_transitions: {
        Row: {
          from_status: Database["public"]["Enums"]["opportunity_status"]
          note: string | null
          to_status: Database["public"]["Enums"]["opportunity_status"]
        }
        Insert: {
          from_status: Database["public"]["Enums"]["opportunity_status"]
          note?: string | null
          to_status: Database["public"]["Enums"]["opportunity_status"]
        }
        Update: {
          from_status?: Database["public"]["Enums"]["opportunity_status"]
          note?: string | null
          to_status?: Database["public"]["Enums"]["opportunity_status"]
        }
        Relationships: []
      }
      platform_format_publishing: {
        Row: {
          content_format: Database["public"]["Enums"]["content_format"]
          media_type: Database["public"]["Enums"]["media_type"] | null
          note: string
          platform: Database["public"]["Enums"]["post_platform"]
          supported: boolean
        }
        Insert: {
          content_format: Database["public"]["Enums"]["content_format"]
          media_type?: Database["public"]["Enums"]["media_type"] | null
          note: string
          platform: Database["public"]["Enums"]["post_platform"]
          supported?: boolean
        }
        Update: {
          content_format?: Database["public"]["Enums"]["content_format"]
          media_type?: Database["public"]["Enums"]["media_type"] | null
          note?: string
          platform?: Database["public"]["Enums"]["post_platform"]
          supported?: boolean
        }
        Relationships: []
      }
      platform_publishing: {
        Row: {
          note: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          provider: string
          supported: boolean
        }
        Insert: {
          note?: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          provider: string
          supported?: boolean
        }
        Update: {
          note?: string | null
          platform?: Database["public"]["Enums"]["post_platform"]
          provider?: string
          supported?: boolean
        }
        Relationships: []
      }
      post_copy: {
        Row: {
          alt_text: string | null
          asset_id: string | null
          caption: string | null
          client_id: string | null
          created_at: string
          created_by: string | null
          created_by_bot: string | null
          cta: string | null
          first_comment: string | null
          hashtags: string[]
          id: string
          link_url: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          scheduled_post_id: string | null
          source: string
          updated_at: string
          version: number
        }
        Insert: {
          alt_text?: string | null
          asset_id?: string | null
          caption?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          created_by_bot?: string | null
          cta?: string | null
          first_comment?: string | null
          hashtags?: string[]
          id?: string
          link_url?: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          scheduled_post_id?: string | null
          source?: string
          updated_at?: string
          version?: number
        }
        Update: {
          alt_text?: string | null
          asset_id?: string | null
          caption?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          created_by_bot?: string | null
          cta?: string | null
          first_comment?: string | null
          hashtags?: string[]
          id?: string
          link_url?: string | null
          platform?: Database["public"]["Enums"]["post_platform"]
          scheduled_post_id?: string | null
          source?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "post_copy_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_copy_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_copy_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "post_copy_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "distribution_due"
            referencedColumns: ["schedule_id"]
          },
          {
            foreignKeyName: "post_copy_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "post_copy_effective"
            referencedColumns: ["scheduled_post_id"]
          },
          {
            foreignKeyName: "post_copy_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["post_id"]
          },
          {
            foreignKeyName: "post_copy_scheduled_post_id_fkey"
            columns: ["scheduled_post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_frame_publications: {
        Row: {
          client_id: string
          external_id: string
          external_url: string | null
          position: number
          post_id: string
          published_at: string
        }
        Insert: {
          client_id: string
          external_id: string
          external_url?: string | null
          position: number
          post_id: string
          published_at?: string
        }
        Update: {
          client_id?: string
          external_id?: string
          external_url?: string | null
          position?: number
          post_id?: string
          published_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_frame_publications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_frame_publications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "post_frame_publications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "distribution_due"
            referencedColumns: ["schedule_id"]
          },
          {
            foreignKeyName: "post_frame_publications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "post_copy_effective"
            referencedColumns: ["scheduled_post_id"]
          },
          {
            foreignKeyName: "post_frame_publications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["post_id"]
          },
          {
            foreignKeyName: "post_frame_publications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "scheduled_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          employee_category: Database["public"]["Enums"]["team_category"] | null
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          employee_category?:
            | Database["public"]["Enums"]["team_category"]
            | null
          full_name?: string | null
          id: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          employee_category?:
            | Database["public"]["Enums"]["team_category"]
            | null
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Relationships: []
      }
      proof_artifact_signoffs: {
        Row: {
          approved_at: string
          approved_by: string
          artifact_version_id: string
          client_id: string
        }
        Insert: {
          approved_at?: string
          approved_by: string
          artifact_version_id: string
          client_id: string
        }
        Update: {
          approved_at?: string
          approved_by?: string
          artifact_version_id?: string
          client_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_artifact_signoffs_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_artifact_signoffs_artifact_version_id_client_id_fkey"
            columns: ["artifact_version_id", "client_id"]
            isOneToOne: false
            referencedRelation: "proof_artifact_versions"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      proof_artifact_versions: {
        Row: {
          artifact_kind: string
          client_id: string
          content: string
          content_hash: string
          created_at: string
          created_by_job_id: string | null
          evidence_excerpt: string
          id: string
          idempotency_key: string
          source_hash: string
          source_proof_id: string
          source_snapshot: Json
          supported_claim: string
          version: number
        }
        Insert: {
          artifact_kind: string
          client_id: string
          content: string
          content_hash: string
          created_at?: string
          created_by_job_id?: string | null
          evidence_excerpt: string
          id?: string
          idempotency_key: string
          source_hash: string
          source_proof_id: string
          source_snapshot: Json
          supported_claim: string
          version: number
        }
        Update: {
          artifact_kind?: string
          client_id?: string
          content?: string
          content_hash?: string
          created_at?: string
          created_by_job_id?: string | null
          evidence_excerpt?: string
          id?: string
          idempotency_key?: string
          source_hash?: string
          source_proof_id?: string
          source_snapshot?: Json
          supported_claim?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "proof_artifact_versions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_artifact_versions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_artifact_versions_created_by_job_id_fkey"
            columns: ["created_by_job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_artifact_versions_created_by_job_id_fkey"
            columns: ["created_by_job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "proof_artifact_versions_created_by_job_id_fkey"
            columns: ["created_by_job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "proof_artifact_versions_source_proof_id_fkey"
            columns: ["source_proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_capture_configs: {
        Row: {
          client_id: string
          created_at: string
          id: string
          instructions: string
          message_template: string | null
          method: string
          name: string
          page_id: string | null
          trigger_event: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          instructions?: string
          message_template?: string | null
          method: string
          name: string
          page_id?: string | null
          trigger_event?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          instructions?: string
          message_template?: string | null
          method?: string
          name?: string
          page_id?: string | null
          trigger_event?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_capture_configs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_capture_configs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_capture_configs_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_capture_configs_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_capture_links: {
        Row: {
          client_id: string
          config_id: string
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          max_submissions: number
          revoked_at: string | null
          submissions: number
          token_hash: string
        }
        Insert: {
          client_id: string
          config_id: string
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          max_submissions?: number
          revoked_at?: string | null
          submissions?: number
          token_hash: string
        }
        Update: {
          client_id?: string
          config_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          max_submissions?: number
          revoked_at?: string | null
          submissions?: number
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_capture_links_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_capture_links_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_capture_links_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "proof_capture_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_capture_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_capture_submissions: {
        Row: {
          client_id: string
          consent_text: string
          created_at: string
          file_mime: string | null
          id: string
          job_reference: string | null
          link_id: string
          proof_id: string
          submitted_name: string
        }
        Insert: {
          client_id: string
          consent_text: string
          created_at?: string
          file_mime?: string | null
          id: string
          job_reference?: string | null
          link_id: string
          proof_id: string
          submitted_name: string
        }
        Update: {
          client_id?: string
          consent_text?: string
          created_at?: string
          file_mime?: string | null
          id?: string
          job_reference?: string | null
          link_id?: string
          proof_id?: string
          submitted_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_capture_submissions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_capture_submissions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_capture_submissions_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "proof_capture_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_capture_submissions_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_destinations: {
        Row: {
          destination_key: string
          executor_module: string
          label: string
          mode: string
          note: string
          provider: string | null
          requires_integration: boolean
          supported: boolean
        }
        Insert: {
          destination_key: string
          executor_module: string
          label: string
          mode: string
          note: string
          provider?: string | null
          requires_integration?: boolean
          supported?: boolean
        }
        Update: {
          destination_key?: string
          executor_module?: string
          label?: string
          mode?: string
          note?: string
          provider?: string | null
          requires_integration?: boolean
          supported?: boolean
        }
        Relationships: []
      }
      proof_placement_approvals: {
        Row: {
          campaign_action_approval_id: string | null
          client_id: string
          decided_at: string | null
          decided_by: string | null
          destination_key: string
          id: string
          payload_hash: string
          placement_id: string
          rejection_reason: string | null
          requested_at: string
          requested_by: string | null
          scope: Json
          status: string
        }
        Insert: {
          campaign_action_approval_id?: string | null
          client_id: string
          decided_at?: string | null
          decided_by?: string | null
          destination_key: string
          id?: string
          payload_hash: string
          placement_id: string
          rejection_reason?: string | null
          requested_at?: string
          requested_by?: string | null
          scope: Json
          status?: string
        }
        Update: {
          campaign_action_approval_id?: string | null
          client_id?: string
          decided_at?: string | null
          decided_by?: string | null
          destination_key?: string
          id?: string
          payload_hash?: string
          placement_id?: string
          rejection_reason?: string | null
          requested_at?: string
          requested_by?: string | null
          scope?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_placement_approvals_campaign_action_approval_id_fkey"
            columns: ["campaign_action_approval_id"]
            isOneToOne: false
            referencedRelation: "campaign_action_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placement_approvals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placement_approvals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_placement_approvals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placement_approvals_destination_key_fkey"
            columns: ["destination_key"]
            isOneToOne: false
            referencedRelation: "proof_destinations"
            referencedColumns: ["destination_key"]
          },
          {
            foreignKeyName: "proof_placement_approvals_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "proof_placement_due"
            referencedColumns: ["placement_id"]
          },
          {
            foreignKeyName: "proof_placement_approvals_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "proof_placements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placement_approvals_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_placement_events: {
        Row: {
          actor: string
          client_id: string
          detail: string | null
          event: string
          external_ref: string | null
          id: string
          occurred_at: string
          placement_id: string
        }
        Insert: {
          actor: string
          client_id: string
          detail?: string | null
          event: string
          external_ref?: string | null
          id?: string
          occurred_at?: string
          placement_id: string
        }
        Update: {
          actor?: string
          client_id?: string
          detail?: string | null
          event?: string
          external_ref?: string | null
          id?: string
          occurred_at?: string
          placement_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_placement_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placement_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_placement_events_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "proof_placement_due"
            referencedColumns: ["placement_id"]
          },
          {
            foreignKeyName: "proof_placement_events_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "proof_placements"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_placement_transitions: {
        Row: {
          from_status: string
          note: string | null
          to_status: string
        }
        Insert: {
          from_status: string
          note?: string | null
          to_status: string
        }
        Update: {
          from_status?: string
          note?: string | null
          to_status?: string
        }
        Relationships: []
      }
      proof_placements: {
        Row: {
          approval_id: string | null
          artifact_version_id: string | null
          asset_id: string | null
          attempts: number
          bound_revision_id: string | null
          bound_version_hash: string | null
          campaign_id: string | null
          claimed_at: string | null
          client_id: string
          created_at: string
          created_by: string | null
          destination_key: string
          external_id: string | null
          external_url: string | null
          id: string
          idempotency_key: string
          last_error: string | null
          lease_until: string | null
          payload_hash: string
          placed_at: string | null
          placed_by: string | null
          production_request_id: string | null
          proof_id: string | null
          retracted_at: string | null
          source_proof_id: string
          status: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          approval_id?: string | null
          artifact_version_id?: string | null
          asset_id?: string | null
          attempts?: number
          bound_revision_id?: string | null
          bound_version_hash?: string | null
          campaign_id?: string | null
          claimed_at?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          destination_key: string
          external_id?: string | null
          external_url?: string | null
          id?: string
          idempotency_key: string
          last_error?: string | null
          lease_until?: string | null
          payload_hash: string
          placed_at?: string | null
          placed_by?: string | null
          production_request_id?: string | null
          proof_id?: string | null
          retracted_at?: string | null
          source_proof_id: string
          status?: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          approval_id?: string | null
          artifact_version_id?: string | null
          asset_id?: string | null
          attempts?: number
          bound_revision_id?: string | null
          bound_version_hash?: string | null
          campaign_id?: string | null
          claimed_at?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          destination_key?: string
          external_id?: string | null
          external_url?: string | null
          id?: string
          idempotency_key?: string
          last_error?: string | null
          lease_until?: string | null
          payload_hash?: string
          placed_at?: string | null
          placed_by?: string | null
          production_request_id?: string | null
          proof_id?: string | null
          retracted_at?: string | null
          source_proof_id?: string
          status?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proof_placement_approval_fk"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "proof_placement_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_artifact_version_id_fkey"
            columns: ["artifact_version_id"]
            isOneToOne: false
            referencedRelation: "proof_artifact_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_placements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_bound_revision_id_fkey"
            columns: ["bound_revision_id"]
            isOneToOne: false
            referencedRelation: "client_page_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_placements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_destination_key_fkey"
            columns: ["destination_key"]
            isOneToOne: false
            referencedRelation: "proof_destinations"
            referencedColumns: ["destination_key"]
          },
          {
            foreignKeyName: "proof_placements_placed_by_fkey"
            columns: ["placed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_production_request_id_fkey"
            columns: ["production_request_id"]
            isOneToOne: false
            referencedRelation: "proof_production_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_source_proof_id_fkey"
            columns: ["source_proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_production_requests: {
        Row: {
          auto_produce: boolean
          client_id: string
          created_at: string
          destination: string
          direction: string
          id: string
          idea_id: string
          job_id: string | null
          production_checked_at: string
          production_error: string | null
          production_job_id: string | null
          production_quality: string
          production_size: string
          production_status: string
          source_asset_id: string | null
          source_proof_id: string
        }
        Insert: {
          auto_produce?: boolean
          client_id: string
          created_at?: string
          destination: string
          direction: string
          id: string
          idea_id: string
          job_id?: string | null
          production_checked_at?: string
          production_error?: string | null
          production_job_id?: string | null
          production_quality?: string
          production_size?: string
          production_status?: string
          source_asset_id?: string | null
          source_proof_id: string
        }
        Update: {
          auto_produce?: boolean
          client_id?: string
          created_at?: string
          destination?: string
          direction?: string
          id?: string
          idea_id?: string
          job_id?: string | null
          production_checked_at?: string
          production_error?: string | null
          production_job_id?: string | null
          production_quality?: string
          production_size?: string
          production_status?: string
          source_asset_id?: string | null
          source_proof_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_production_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_production_requests_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: true
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: true
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
          {
            foreignKeyName: "proof_production_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "proof_production_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "proof_production_requests_production_job_id_fkey"
            columns: ["production_job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_production_job_id_fkey"
            columns: ["production_job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "proof_production_requests_production_job_id_fkey"
            columns: ["production_job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_production_requests_source_proof_id_fkey"
            columns: ["source_proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_request_deliveries: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          attempts: number
          capture_url: string
          channel: string
          client_id: string
          config_id: string
          created_at: string
          error: string | null
          event_key: string
          id: string
          lease_until: string | null
          link_id: string
          message: string
          provider_id: string | null
          recipient: string
          scheduled_at: string
          sent_at: string | null
          status: string
          subject: string
          template_sid: string | null
          template_variables: Json | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          capture_url: string
          channel: string
          client_id: string
          config_id: string
          created_at?: string
          error?: string | null
          event_key: string
          id: string
          lease_until?: string | null
          link_id: string
          message: string
          provider_id?: string | null
          recipient: string
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          subject: string
          template_sid?: string | null
          template_variables?: Json | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          capture_url?: string
          channel?: string
          client_id?: string
          config_id?: string
          created_at?: string
          error?: string | null
          event_key?: string
          id?: string
          lease_until?: string | null
          link_id?: string
          message?: string
          provider_id?: string | null
          recipient?: string
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          subject?: string
          template_sid?: string | null
          template_variables?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "proof_request_deliveries_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_request_deliveries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_request_deliveries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_request_deliveries_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "proof_capture_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_request_deliveries_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "proof_capture_links"
            referencedColumns: ["id"]
          },
        ]
      }
      proof_rights_events: {
        Row: {
          actor_id: string | null
          actor_role: string
          changed_at: string
          client_id: string
          id: string
          new_expiry: string | null
          new_rights: string
          permission_basis: string | null
          previous_expiry: string | null
          previous_rights: string
          proof_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_role: string
          changed_at?: string
          client_id: string
          id?: string
          new_expiry?: string | null
          new_rights: string
          permission_basis?: string | null
          previous_expiry?: string | null
          previous_rights: string
          proof_id: string
        }
        Update: {
          actor_id?: string | null
          actor_role?: string
          changed_at?: string
          client_id?: string
          id?: string
          new_expiry?: string | null
          new_rights?: string
          permission_basis?: string | null
          previous_expiry?: string | null
          previous_rights?: string
          proof_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proof_rights_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_rights_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_rights_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_rights_events_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      record_templates: {
        Row: {
          description: string | null
          display_order: number
          domain: Database["public"]["Enums"]["record_domain"]
          item_key: string
          item_type: string
          title: string
        }
        Insert: {
          description?: string | null
          display_order?: number
          domain: Database["public"]["Enums"]["record_domain"]
          item_key: string
          item_type?: string
          title: string
        }
        Update: {
          description?: string | null
          display_order?: number
          domain?: Database["public"]["Enums"]["record_domain"]
          item_key?: string
          item_type?: string
          title?: string
        }
        Relationships: []
      }
      recruitment_meta_campaign_ads: {
        Row: {
          asset_id: string
          campaign_id: string
          meta_ad_id: string | null
          meta_creative_id: string | null
          meta_image_hash: string | null
        }
        Insert: {
          asset_id: string
          campaign_id: string
          meta_ad_id?: string | null
          meta_creative_id?: string | null
          meta_image_hash?: string | null
        }
        Update: {
          asset_id?: string
          campaign_id?: string
          meta_ad_id?: string | null
          meta_creative_id?: string | null
          meta_image_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaign_ads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "recruitment_meta_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      recruitment_meta_campaigns: {
        Row: {
          client_id: string
          conversion_event: string
          created_at: string
          created_by: string | null
          daily_budget: number
          id: string
          meta_ad_set_id: string | null
          meta_built_at: string | null
          meta_campaign_id: string | null
          name: string
          target_countries: string[]
        }
        Insert: {
          client_id: string
          conversion_event?: string
          created_at?: string
          created_by?: string | null
          daily_budget: number
          id?: string
          meta_ad_set_id?: string | null
          meta_built_at?: string | null
          meta_campaign_id?: string | null
          name: string
          target_countries: string[]
        }
        Update: {
          client_id?: string
          conversion_event?: string
          created_at?: string
          created_by?: string | null
          daily_budget?: number
          id?: string
          meta_ad_set_id?: string | null
          meta_built_at?: string | null
          meta_campaign_id?: string | null
          name?: string
          target_countries?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "recruitment_meta_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "recruitment_meta_campaigns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ref_counters: {
        Row: {
          client_id: string
          last_value: number
        }
        Insert: {
          client_id: string
          last_value?: number
        }
        Update: {
          client_id?: string
          last_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "ref_counters_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ref_counters_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      sales_agent_conversations: {
        Row: {
          client_id: string
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          deployment_id: string | null
          ended_at: string | null
          handed_over: boolean
          id: string
          lead_id: string | null
          outcome: string | null
          page_id: string | null
          qualified: boolean
          sales_agent_id: string
          started_at: string
          transcript: Json
        }
        Insert: {
          client_id: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          deployment_id?: string | null
          ended_at?: string | null
          handed_over?: boolean
          id?: string
          lead_id?: string | null
          outcome?: string | null
          page_id?: string | null
          qualified?: boolean
          sales_agent_id: string
          started_at?: string
          transcript?: Json
        }
        Update: {
          client_id?: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          deployment_id?: string | null
          ended_at?: string | null
          handed_over?: boolean
          id?: string
          lead_id?: string | null
          outcome?: string | null
          page_id?: string | null
          qualified?: boolean
          sales_agent_id?: string
          started_at?: string
          transcript?: Json
        }
        Relationships: [
          {
            foreignKeyName: "sales_agent_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "client_sales_agent_deployments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "client_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_sales_agent_id_fkey"
            columns: ["sales_agent_id"]
            isOneToOne: false
            referencedRelation: "client_sales_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_agent_conversations_sales_agent_id_fkey"
            columns: ["sales_agent_id"]
            isOneToOne: false
            referencedRelation: "sales_agents_archive"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_runtime_requests: {
        Row: {
          client_id: string
          conversation_id: string | null
          cost_usd: number
          deployment_id: string
          id: string
          ip_hash: string | null
          occurred_at: string
          origin: string | null
          outcome: string
        }
        Insert: {
          client_id: string
          conversation_id?: string | null
          cost_usd?: number
          deployment_id: string
          id?: string
          ip_hash?: string | null
          occurred_at?: string
          origin?: string | null
          outcome: string
        }
        Update: {
          client_id?: string
          conversation_id?: string | null
          cost_usd?: number
          deployment_id?: string
          id?: string
          ip_hash?: string | null
          occurred_at?: string
          origin?: string | null
          outcome?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_runtime_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_runtime_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "sales_runtime_requests_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "sales_agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_runtime_requests_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "client_sales_agent_deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_posts: {
        Row: {
          asset_id: string | null
          channel: Database["public"]["Enums"]["post_channel"]
          client_id: string | null
          created_at: string
          created_by: string | null
          created_by_bot: string | null
          external_id: string | null
          external_url: string | null
          failure_reason: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          notes: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          publication_status: string
          publish_attempts: number
          publish_claimed_at: string | null
          published_at: string | null
          published_by_bot: string | null
          ref_number: string | null
          scheduled_at: string
          scheduled_for: string
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          channel?: Database["public"]["Enums"]["post_channel"]
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          created_by_bot?: string | null
          external_id?: string | null
          external_url?: string | null
          failure_reason?: string | null
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          notes?: string | null
          platform?: Database["public"]["Enums"]["post_platform"] | null
          publication_status?: string
          publish_attempts?: number
          publish_claimed_at?: string | null
          published_at?: string | null
          published_by_bot?: string | null
          ref_number?: string | null
          scheduled_at: string
          scheduled_for: string
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          channel?: Database["public"]["Enums"]["post_channel"]
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          created_by_bot?: string | null
          external_id?: string | null
          external_url?: string | null
          failure_reason?: string | null
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          notes?: string | null
          platform?: Database["public"]["Enums"]["post_platform"] | null
          publication_status?: string
          publish_attempts?: number
          publish_claimed_at?: string | null
          published_at?: string | null
          published_by_bot?: string | null
          ref_number?: string | null
          scheduled_at?: string
          scheduled_for?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "scheduled_posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      service_offer_signoffs: {
        Row: {
          approved_at: string
          approved_by: string
          client_id: string
          offer_version_id: string
        }
        Insert: {
          approved_at?: string
          approved_by: string
          client_id: string
          offer_version_id: string
        }
        Update: {
          approved_at?: string
          approved_by?: string
          client_id?: string
          offer_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_offer_signoffs_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_offer_signoffs_offer_version_id_client_id_fkey"
            columns: ["offer_version_id", "client_id"]
            isOneToOne: false
            referencedRelation: "service_offer_versions"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      service_offer_versions: {
        Row: {
          audience: string
          claims: Json
          client_id: string
          content_hash: string
          created_at: string
          currency: string | null
          delivery_cost_estimate: number | null
          exclusions: string[]
          id: string
          idempotency_key: string
          inclusions: string[]
          offer_id: string
          price_amount: number | null
          promise: string
          version: number
        }
        Insert: {
          audience: string
          claims?: Json
          client_id: string
          content_hash: string
          created_at?: string
          currency?: string | null
          delivery_cost_estimate?: number | null
          exclusions?: string[]
          id?: string
          idempotency_key: string
          inclusions?: string[]
          offer_id: string
          price_amount?: number | null
          promise: string
          version: number
        }
        Update: {
          audience?: string
          claims?: Json
          client_id?: string
          content_hash?: string
          created_at?: string
          currency?: string | null
          delivery_cost_estimate?: number | null
          exclusions?: string[]
          id?: string
          idempotency_key?: string
          inclusions?: string[]
          offer_id?: string
          price_amount?: number | null
          promise?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "service_offer_versions_offer_id_client_id_fkey"
            columns: ["offer_id", "client_id"]
            isOneToOne: false
            referencedRelation: "service_offers"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      service_offers: {
        Row: {
          client_id: string
          created_at: string
          id: string
          service_name: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          service_name: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          service_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_offers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_offers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      slot_events: {
        Row: {
          actor: string
          actor_id: string | null
          agent_key: string | null
          cost_usd: number | null
          created_at: string
          from_stage: Database["public"]["Enums"]["slot_stage"] | null
          id: string
          job_id: string | null
          note: string | null
          slot_id: string
          to_stage: Database["public"]["Enums"]["slot_stage"]
        }
        Insert: {
          actor?: string
          actor_id?: string | null
          agent_key?: string | null
          cost_usd?: number | null
          created_at?: string
          from_stage?: Database["public"]["Enums"]["slot_stage"] | null
          id?: string
          job_id?: string | null
          note?: string | null
          slot_id: string
          to_stage: Database["public"]["Enums"]["slot_stage"]
        }
        Update: {
          actor?: string
          actor_id?: string | null
          agent_key?: string | null
          cost_usd?: number | null
          created_at?: string
          from_stage?: Database["public"]["Enums"]["slot_stage"] | null
          id?: string
          job_id?: string | null
          note?: string | null
          slot_id?: string
          to_stage?: Database["public"]["Enums"]["slot_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "content_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slot_board"
            referencedColumns: ["slot_id"]
          },
        ]
      }
      slot_pipeline: {
        Row: {
          agent_key: string
          enter_stage: Database["public"]["Enums"]["slot_stage"] | null
          format: Database["public"]["Enums"]["content_format"] | null
          input_column: string | null
          input_table: string | null
          note: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
        }
        Insert: {
          agent_key: string
          enter_stage?: Database["public"]["Enums"]["slot_stage"] | null
          format?: Database["public"]["Enums"]["content_format"] | null
          input_column?: string | null
          input_table?: string | null
          note?: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
        }
        Update: {
          agent_key?: string
          enter_stage?: Database["public"]["Enums"]["slot_stage"] | null
          format?: Database["public"]["Enums"]["content_format"] | null
          input_column?: string | null
          input_table?: string | null
          note?: string | null
          stage?: Database["public"]["Enums"]["slot_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "slot_pipeline_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agent_stats"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "slot_pipeline_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["agent_key"]
          },
        ]
      }
      slot_transitions: {
        Row: {
          from_stage: Database["public"]["Enums"]["slot_stage"]
          note: string | null
          to_stage: Database["public"]["Enums"]["slot_stage"]
        }
        Insert: {
          from_stage: Database["public"]["Enums"]["slot_stage"]
          note?: string | null
          to_stage: Database["public"]["Enums"]["slot_stage"]
        }
        Update: {
          from_stage?: Database["public"]["Enums"]["slot_stage"]
          note?: string | null
          to_stage?: Database["public"]["Enums"]["slot_stage"]
        }
        Relationships: []
      }
      sops: {
        Row: {
          created_at: string
          id: string
          owner_id: string | null
          storage_path: string
          title: string
          updated_at: string
          uploaded_by: string | null
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          owner_id?: string | null
          storage_path: string
          title: string
          updated_at?: string
          uploaded_by?: string | null
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          owner_id?: string | null
          storage_path?: string
          title?: string
          updated_at?: string
          uploaded_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "sops_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sops_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_channels: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_channels_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          active: boolean
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          category: Database["public"]["Enums"]["team_category"]
          company_name: string | null
          contact_info: string | null
          created_at: string
          email: string | null
          engagement: Database["public"]["Enums"]["engagement_type"]
          family_name: string | null
          given_name: string | null
          id: string
          initials: string
          legal_name: string | null
          name: string
          personal_info: string | null
          phone: string | null
          preferred_name: string | null
          profile_notes: string | null
          tax_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          category: Database["public"]["Enums"]["team_category"]
          company_name?: string | null
          contact_info?: string | null
          created_at?: string
          email?: string | null
          engagement?: Database["public"]["Enums"]["engagement_type"]
          family_name?: string | null
          given_name?: string | null
          id?: string
          initials: string
          legal_name?: string | null
          name: string
          personal_info?: string | null
          phone?: string | null
          preferred_name?: string | null
          profile_notes?: string | null
          tax_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          category?: Database["public"]["Enums"]["team_category"]
          company_name?: string | null
          contact_info?: string | null
          created_at?: string
          email?: string | null
          engagement?: Database["public"]["Enums"]["engagement_type"]
          family_name?: string | null
          given_name?: string | null
          id?: string
          initials?: string
          legal_name?: string | null
          name?: string
          personal_info?: string | null
          phone?: string | null
          preferred_name?: string | null
          profile_notes?: string | null
          tax_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_messages: {
        Row: {
          author_id: string | null
          body: string
          channel_id: string
          created_at: string
          id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          channel_id: string
          created_at?: string
          id?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          channel_id?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "team_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v5_reel_source_rebuild_activation: {
        Row: {
          activated_at: string
          singleton: boolean
        }
        Insert: {
          activated_at?: string
          singleton?: boolean
        }
        Update: {
          activated_at?: string
          singleton?: boolean
        }
        Relationships: []
      }
      video_approval_signoffs: {
        Row: {
          approval_role: string
          asset_id: string
          render_path: string
          signed_at: string
          user_id: string
        }
        Insert: {
          approval_role: string
          asset_id: string
          render_path: string
          signed_at?: string
          user_id: string
        }
        Update: {
          approval_role?: string
          asset_id?: string
          render_path?: string
          signed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_approval_signoffs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      video_client_approval_requests: {
        Row: {
          asset_id: string
          client_user_id: string
          email_error: string | null
          email_status: string
          emailed_at: string | null
          job_id: string | null
          rejected_at: string | null
          rejection_reason: string | null
          requested_at: string
          requested_by: string
        }
        Insert: {
          asset_id: string
          client_user_id: string
          email_error?: string | null
          email_status?: string
          emailed_at?: string | null
          job_id?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          requested_at?: string
          requested_by: string
        }
        Update: {
          asset_id?: string
          client_user_id?: string
          email_error?: string | null
          email_status?: string
          emailed_at?: string | null
          job_id?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          requested_at?: string
          requested_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_client_user_id_fkey"
            columns: ["client_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_client_approval_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      video_render_candidates: {
        Row: {
          asset_id: string
          attempt: number
          client_id: string
          created_at: string
          creative_review: Json | null
          edit_plan: Json | null
          id: string
          job_id: string
          media_probe: Json
          rejection_reason: string | null
          render_path: string
          reviewed_at: string | null
          verdict: string
        }
        Insert: {
          asset_id: string
          attempt: number
          client_id: string
          created_at?: string
          creative_review?: Json | null
          edit_plan?: Json | null
          id?: string
          job_id: string
          media_probe: Json
          rejection_reason?: string | null
          render_path: string
          reviewed_at?: string | null
          verdict?: string
        }
        Update: {
          asset_id?: string
          attempt?: number
          client_id?: string
          created_at?: string
          creative_review?: Json | null
          edit_plan?: Json | null
          id?: string
          job_id?: string
          media_probe?: Json
          rejection_reason?: string | null
          render_path?: string
          reviewed_at?: string | null
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_render_candidates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_render_candidates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_render_candidates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "video_render_candidates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_render_candidates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_render_candidates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
        ]
      }
      video_repurpose_clip_requests: {
        Row: {
          brief_id: string
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          derivative_id: string
          error: string | null
          id: string
          job_id: string | null
          output_asset_id: string | null
          source_asset_id: string
          source_in_sec: number
          source_out_sec: number
          status: string
        }
        Insert: {
          brief_id: string
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          derivative_id: string
          error?: string | null
          id?: string
          job_id?: string | null
          output_asset_id?: string | null
          source_asset_id: string
          source_in_sec: number
          source_out_sec: number
          status?: string
        }
        Update: {
          brief_id?: string
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          derivative_id?: string
          error?: string | null
          id?: string
          job_id?: string | null
          output_asset_id?: string | null
          source_asset_id?: string
          source_in_sec?: number
          source_out_sec?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_repurpose_clip_requests_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_derivative_id_fkey"
            columns: ["derivative_id"]
            isOneToOne: false
            referencedRelation: "video_repurpose_derivatives"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_clip_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      video_repurpose_derivatives: {
        Row: {
          candidate_index: number
          created_at: string
          exact_quote: string
          id: string
          idea_id: string
          reentry_stage: string
          request_id: string
          source_asset_id: string
          source_in_sec: number
          source_out_sec: number
          target_platform: Database["public"]["Enums"]["post_platform"]
        }
        Insert: {
          candidate_index: number
          created_at?: string
          exact_quote: string
          id?: string
          idea_id: string
          reentry_stage?: string
          request_id: string
          source_asset_id: string
          source_in_sec: number
          source_out_sec: number
          target_platform: Database["public"]["Enums"]["post_platform"]
        }
        Update: {
          candidate_index?: number
          created_at?: string
          exact_quote?: string
          id?: string
          idea_id?: string
          reentry_stage?: string
          request_id?: string
          source_asset_id?: string
          source_in_sec?: number
          source_out_sec?: number
          target_platform?: Database["public"]["Enums"]["post_platform"]
        }
        Relationships: [
          {
            foreignKeyName: "video_repurpose_derivatives_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "video_repurpose_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_derivatives_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      video_repurpose_requests: {
        Row: {
          candidates: Json | null
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          direction: string
          error: string | null
          id: string
          job_id: string | null
          source_asset_id: string
          status: string
          transcript: Json | null
        }
        Insert: {
          candidates?: Json | null
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          direction?: string
          error?: string | null
          id?: string
          job_id?: string | null
          source_asset_id: string
          status?: string
          transcript?: Json | null
        }
        Update: {
          candidates?: Json | null
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          direction?: string
          error?: string | null
          id?: string
          job_id?: string | null
          source_asset_id?: string
          status?: string
          transcript?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "video_repurpose_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_repurpose_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      video_sound_assets: {
        Row: {
          attested_at: string
          attested_by: string
          client_id: string
          created_at: string
          id: string
          kind: string
          rights_reference: string
          storage_path: string
        }
        Insert: {
          attested_at?: string
          attested_by: string
          client_id: string
          created_at?: string
          id?: string
          kind: string
          rights_reference: string
          storage_path: string
        }
        Update: {
          attested_at?: string
          attested_by?: string
          client_id?: string
          created_at?: string
          id?: string
          kind?: string
          rights_reference?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_sound_assets_attested_by_fkey"
            columns: ["attested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_sound_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_sound_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      video_source_edit_requests: {
        Row: {
          animated_title: boolean
          aspect: string
          brand_treatment: string
          captions: boolean
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          direction: string
          edit_plan: Json | null
          error: string | null
          feel: string
          id: string
          job_id: string | null
          output_asset_id: string | null
          remove_pauses: boolean
          source_asset_id: string
          status: string
          transcript: Json | null
        }
        Insert: {
          animated_title?: boolean
          aspect: string
          brand_treatment: string
          captions?: boolean
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          direction: string
          edit_plan?: Json | null
          error?: string | null
          feel: string
          id?: string
          job_id?: string | null
          output_asset_id?: string | null
          remove_pauses?: boolean
          source_asset_id: string
          status?: string
          transcript?: Json | null
        }
        Update: {
          animated_title?: boolean
          aspect?: string
          brand_treatment?: string
          captions?: boolean
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          direction?: string
          edit_plan?: Json | null
          error?: string | null
          feel?: string
          id?: string
          job_id?: string | null
          output_asset_id?: string | null
          remove_pauses?: boolean
          source_asset_id?: string
          status?: string
          transcript?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "video_source_edit_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"
            columns: ["output_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      work_logs: {
        Row: {
          client_id: string | null
          created_at: string
          id: string
          logged_on: string
          member_id: string
          minutes: number | null
          work_done: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          id?: string
          logged_on?: string
          member_id: string
          minutes?: number | null
          work_done: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          id?: string
          logged_on?: string
          member_id?: string
          minutes?: number | null
          work_done?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "work_logs_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_artifacts: {
        Row: {
          accepted_at: string
          artifact_kind: string
          id: string
          qa_evidence: Json
          record_id: string
          run_id: string
          step_id: string
          version_key: string
        }
        Insert: {
          accepted_at?: string
          artifact_kind: string
          id?: string
          qa_evidence: Json
          record_id: string
          run_id: string
          step_id: string
          version_key: string
        }
        Update: {
          accepted_at?: string
          artifact_kind?: string
          id?: string
          qa_evidence?: Json
          record_id?: string
          run_id?: string
          step_id?: string
          version_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_artifacts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_artifacts_step_id_run_id_fkey"
            columns: ["step_id", "run_id"]
            isOneToOne: false
            referencedRelation: "workflow_steps"
            referencedColumns: ["id", "run_id"]
          },
        ]
      }
      workflow_lead_attribution: {
        Row: {
          evidence: Json
          label: string
          lead_id: string
          recorded_at: string
          run_id: string
        }
        Insert: {
          evidence: Json
          label: string
          lead_id: string
          recorded_at?: string
          run_id: string
        }
        Update: {
          evidence?: Json
          label?: string
          lead_id?: string
          recorded_at?: string
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_lead_attribution_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "client_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_lead_attribution_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "lead_progress"
            referencedColumns: ["lead_id"]
          },
          {
            foreignKeyName: "workflow_lead_attribution_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_reel_source_rebuilds: {
        Row: {
          created_at: string
          edit_step_id: string
          feedback: string
          id: string
          prior_artifacts: Json
          run_id: string
          source_asset_id: string
        }
        Insert: {
          created_at?: string
          edit_step_id: string
          feedback: string
          id?: string
          prior_artifacts: Json
          run_id: string
          source_asset_id: string
        }
        Update: {
          created_at?: string
          edit_step_id?: string
          feedback?: string
          id?: string
          prior_artifacts?: Json
          run_id?: string
          source_asset_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_reel_source_rebuilds_edit_step_id_fkey"
            columns: ["edit_step_id"]
            isOneToOne: false
            referencedRelation: "workflow_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "workflow_reel_source_rebuilds_source_asset_id_fkey"
            columns: ["source_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_runs: {
        Row: {
          blocker: string | null
          campaign_id: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          deadline_at: string
          id: string
          idempotency_key: string
          input_snapshot: Json
          kind: string
          review_ready_at: string | null
          root_request_id: string | null
          sealed_at: string | null
          status: string
          updated_at: string
          workflow_version: string
        }
        Insert: {
          blocker?: string | null
          campaign_id?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deadline_at: string
          id?: string
          idempotency_key: string
          input_snapshot: Json
          kind: string
          review_ready_at?: string | null
          root_request_id?: string | null
          sealed_at?: string | null
          status?: string
          updated_at?: string
          workflow_version: string
        }
        Update: {
          blocker?: string | null
          campaign_id?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deadline_at?: string
          id?: string
          idempotency_key?: string
          input_snapshot?: Json
          kind?: string
          review_ready_at?: string | null
          root_request_id?: string | null
          sealed_at?: string | null
          status?: string
          updated_at?: string
          workflow_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns_archive"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "client_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "workflow_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_steps: {
        Row: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        Insert: {
          agent_key: string
          blocker?: string | null
          completed_at?: string | null
          created_at?: string
          dependencies?: string[]
          id?: string
          input_from_step_key?: string | null
          input_id?: string | null
          input_params?: Json
          input_table: string
          job_id?: string | null
          resolved_input_id?: string | null
          run_id: string
          status?: string
          step_key: string
          updated_at?: string
        }
        Update: {
          agent_key?: string
          blocker?: string | null
          completed_at?: string | null
          created_at?: string
          dependencies?: string[]
          id?: string
          input_from_step_key?: string | null
          input_id?: string | null
          input_params?: Json
          input_table?: string
          job_id?: string | null
          resolved_input_id?: string | null
          run_id?: string
          status?: string
          step_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_steps_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agent_stats"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "workflow_steps_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "workflow_steps_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_steps_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "held_jobs"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "workflow_steps_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "metrics_pulls"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "workflow_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      agent_runtime_status: {
        Row: {
          active_jobs: number | null
          age: string | null
          is_live: boolean | null
          metadata: Json | null
          queue_depth: number | null
          reported_at: string | null
          status: string | null
          version: string | null
          worker_id: string | null
        }
        Insert: {
          active_jobs?: number | null
          age?: never
          is_live?: never
          metadata?: Json | null
          queue_depth?: number | null
          reported_at?: string | null
          status?: string | null
          version?: string | null
          worker_id?: string | null
        }
        Update: {
          active_jobs?: number | null
          age?: never
          is_live?: never
          metadata?: Json | null
          queue_depth?: number | null
          reported_at?: string | null
          status?: string | null
          version?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      agent_stats: {
        Row: {
          agent_key: string | null
          avg_monthly_cost: number | null
          failed_runs: number | null
          failure_rate: number | null
          name: string | null
          runs: number | null
          total_cost: number | null
        }
        Relationships: []
      }
      approval_inbox: {
        Row: {
          asset_id: string | null
          asset_title: string | null
          attempts: number | null
          client_id: string | null
          client_name: string | null
          cost_usd: number | null
          finding_count: number | null
          format: Database["public"]["Enums"]["content_format"] | null
          goes_out_in: string | null
          human_approved_at: string | null
          idea_reasons: Json | null
          idea_score: number | null
          overdue: boolean | null
          pillar_name: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          qa_findings: Json | null
          qa_score: number | null
          scheduled_at: string | null
          slot_id: string | null
          waiting_for: string | null
          warnings: number | null
        }
        Relationships: [
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      approval_queue_slots: {
        Row: {
          asset_id: string | null
          asset_title: string | null
          attempts: number | null
          client_id: string | null
          client_name: string | null
          cost_usd: number | null
          finding_count: number | null
          format: Database["public"]["Enums"]["content_format"] | null
          human_approved_at: string | null
          idea_reasons: Json | null
          idea_score: number | null
          pillar_name: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          qa_findings: Json | null
          qa_score: number | null
          scheduled_at: string | null
          slot_id: string | null
          warnings: number | null
        }
        Relationships: [
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      approvals_queue: {
        Row: {
          ad_cta: string | null
          ad_description: string | null
          ad_headline: string | null
          ad_link_url: string | null
          ad_primary_text: string | null
          brief_id: string | null
          brief_title: string | null
          client_id: string | null
          client_name: string | null
          created_at: string | null
          human_approved_at: string | null
          id: string | null
          media_type: Database["public"]["Enums"]["media_type"] | null
          member_id: string | null
          meta_ad_id: string | null
          meta_creative_id: string | null
          meta_image_hash: string | null
          purpose: Database["public"]["Enums"]["content_purpose"] | null
          ref_number: string | null
          review_status: Database["public"]["Enums"]["review_status"] | null
          storage_path: string | null
          title: string | null
          updated_at: string | null
          uploaded_by: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_media_assets_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "client_media_assets_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_media_assets_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_board: {
        Row: {
          accepted_at: string | null
          asset_id: string | null
          assignment_id: string | null
          brief_id: string | null
          client_id: string | null
          client_name: string | null
          compensation: number | null
          completed_at: string | null
          days_late: number | null
          delivered_at: string | null
          due_date: string | null
          finished: boolean | null
          member_id: string | null
          member_name: string | null
          overdue: boolean | null
          stage: string | null
          stage_reason: string | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "job_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_archive"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "job_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "job_assignments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_totals: {
        Row: {
          active_campaigns: number | null
          current_daily_spend: number | null
          lifetime_spend: number | null
        }
        Relationships: []
      }
      campaigns_archive: {
        Row: {
          archived_at: string | null
          budget: number | null
          client_id: string | null
          created_at: string | null
          ends_on: string | null
          id: string | null
          kind: string | null
          launched_at: string | null
          objective: string | null
          pieces: number | null
          starts_on: string | null
          status: string | null
          title: string | null
        }
        Insert: {
          archived_at?: string | null
          budget?: number | null
          client_id?: string | null
          created_at?: string | null
          ends_on?: string | null
          id?: string | null
          kind?: never
          launched_at?: string | null
          objective?: string | null
          pieces?: never
          starts_on?: string | null
          status?: string | null
          title?: string | null
        }
        Update: {
          archived_at?: string | null
          budget?: number | null
          client_id?: string | null
          created_at?: string | null
          ends_on?: string | null
          id?: string | null
          kind?: never
          launched_at?: string | null
          objective?: string | null
          pieces?: never
          starts_on?: string | null
          status?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_billing_view: {
        Row: {
          client_id: string | null
          current_plan: string | null
          duration_days: number | null
          duration_from: string | null
          monthly_amount: number | null
          started_on: string | null
          updated_at: string | null
          upsell_opportunity: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_billing_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_billing_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      content_archive: {
        Row: {
          approved_assets: number | null
          archived_at: string | null
          assets: number | null
          brief_id: string | null
          brief_ref: string | null
          client_id: string | null
          content_format: Database["public"]["Enums"]["content_format"] | null
          content_territory: string | null
          first_published: string | null
          frame_count: number | null
          idea_id: string | null
          idea_title: string | null
          iterations: number | null
          media_type: Database["public"]["Enums"]["media_type"] | null
          pillar_id: string | null
          pillar_name: string | null
          published: number | null
          scheduled: number | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_briefs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_briefs_source_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_source_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["idea_id"]
          },
          {
            foreignKeyName: "client_ideas_pillar_id_fkey"
            columns: ["pillar_id"]
            isOneToOne: false
            referencedRelation: "client_content_pillars"
            referencedColumns: ["id"]
          },
        ]
      }
      content_attribution: {
        Row: {
          appointments: number | null
          asset_created_at: string | null
          asset_id: string | null
          asset_ref: string | null
          asset_title: string | null
          brief_id: string | null
          brief_ref: string | null
          call_to_action: string | null
          cash_collected: number | null
          channel_intent: string | null
          channels: string | null
          clicks: number | null
          client_id: string | null
          content_territory: string | null
          conversations: number | null
          derived_from_asset_id: string | null
          first_published: string | null
          followers: number | null
          hook: string | null
          idea_id: string | null
          idea_title: string | null
          impressions: number | null
          leads: number | null
          lost: number | null
          media_type: Database["public"]["Enums"]["media_type"] | null
          opportunity_value: number | null
          posts: number | null
          profile_visits: number | null
          proof_asset_id: string | null
          qualified: number | null
          reach: number | null
          repurpose_format: string | null
          review_status: Database["public"]["Enums"]["review_status"] | null
          sale_value: number | null
          sales: number | null
          spend: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "client_briefs_derived_from_asset_id_fkey"
            columns: ["derived_from_asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_briefs_proof_asset_id_fkey"
            columns: ["proof_asset_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      distribution_due: {
        Row: {
          asset_id: string | null
          asset_title: string | null
          channel: string | null
          client_id: string | null
          content_format: string | null
          days_late: number | null
          due_now: boolean | null
          human_approved: boolean | null
          media_type: string | null
          platform: string | null
          ref_number: string | null
          schedule_id: string | null
          scheduled_at: string | null
          scheduled_for: string | null
          state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      engine_activity: {
        Row: {
          clients_considered: number | null
          clients_skipped: number | null
          id: string | null
          jobs_queued: number | null
          notes: Json | null
          slots_planned: number | null
          started_at: string | null
          took: string | null
        }
        Insert: {
          clients_considered?: number | null
          clients_skipped?: number | null
          id?: string | null
          jobs_queued?: number | null
          notes?: Json | null
          slots_planned?: number | null
          started_at?: string | null
          took?: never
        }
        Update: {
          clients_considered?: number | null
          clients_skipped?: number | null
          id?: string | null
          jobs_queued?: number | null
          notes?: Json | null
          slots_planned?: number | null
          started_at?: string | null
          took?: never
        }
        Relationships: []
      }
      engine_readiness: {
        Row: {
          active_pillars: number | null
          active_platforms: number | null
          approval_mode: string | null
          client_id: string | null
          client_name: string | null
          enabled: boolean | null
          month_cap_usd: number | null
          plan_horizon_days: number | null
          posting_windows: number | null
          posts_per_week: number | null
          readiness: string | null
          timezone: string | null
        }
        Relationships: []
      }
      held_jobs: {
        Row: {
          agent_key: string | null
          agent_name: string | null
          client_id: string | null
          client_name: string | null
          created_at: string | null
          held_because: string | null
          job_id: string | null
          slot_id: string | null
          waiting_for: string | null
          would_resume_now: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_jobs_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agent_stats"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "agent_jobs_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["agent_key"]
          },
          {
            foreignKeyName: "agent_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      integration_health: {
        Row: {
          client_id: string | null
          client_name: string | null
          headline: string | null
          health_detail: string | null
          ingest_enabled: boolean | null
          last_checked_at: string | null
          provider: string | null
          status: string | null
          token_expires_at: string | null
          usable: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "client_integrations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_integrations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      lead_pipeline_counts: {
        Row: {
          client_id: string | null
          lead_count: number | null
          pipeline_stage: Database["public"]["Enums"]["pipeline_stage"] | null
        }
        Relationships: [
          {
            foreignKeyName: "client_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      lead_progress: {
        Row: {
          cash_collected: number | null
          client_id: string | null
          created_at: string | null
          ever_lost: boolean | null
          furthest_rank: number | null
          lead_id: string | null
          opportunity_value: number | null
          sale_value: number | null
          source_campaign_id: string | null
          source_channel: string | null
          stage: Database["public"]["Enums"]["lead_stage"] | null
        }
        Insert: {
          cash_collected?: never
          client_id?: string | null
          created_at?: string | null
          ever_lost?: never
          furthest_rank?: never
          lead_id?: string | null
          opportunity_value?: never
          sale_value?: never
          source_campaign_id?: string | null
          source_channel?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"] | null
        }
        Update: {
          cash_collected?: never
          client_id?: string | null
          created_at?: string | null
          ever_lost?: never
          furthest_rank?: never
          lead_id?: string | null
          opportunity_value?: never
          sale_value?: never
          source_campaign_id?: string | null
          source_channel?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"] | null
        }
        Relationships: [
          {
            foreignKeyName: "client_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_leads_source_campaign_id_fkey"
            columns: ["source_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_coverage: {
        Row: {
          client_id: string | null
          days_missing_inside: number | null
          days_with_data: number | null
          first_day: string | null
          last_day: string | null
          last_fetched_at: string | null
          surface: string | null
        }
        Relationships: [
          {
            foreignKeyName: "metrics_daily_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_daily_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      metrics_pulls: {
        Row: {
          asked_for_by_hand: boolean | null
          client_id: string | null
          completed_at: string | null
          created_at: string | null
          error: string | null
          job_id: string | null
          since: string | null
          status: string | null
          surface: string | null
          until: string | null
        }
        Insert: {
          asked_for_by_hand?: never
          client_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          error?: string | null
          job_id?: string | null
          since?: never
          status?: never
          surface?: never
          until?: never
        }
        Update: {
          asked_for_by_hand?: never
          client_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          error?: string | null
          job_id?: string | null
          since?: never
          status?: never
          surface?: never
          until?: never
        }
        Relationships: [
          {
            foreignKeyName: "agent_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      mrr_from_billing: {
        Row: {
          mrr: number | null
          paying_clients: number | null
        }
        Relationships: []
      }
      opportunity_readiness: {
        Row: {
          awareness_stages: number | null
          blocker: string | null
          classification: string | null
          client_id: string | null
          confidence:
            | Database["public"]["Enums"]["opportunity_confidence"]
            | null
          name: string | null
          open_proof_gaps: number | null
          opportunity_id: string | null
          score: number | null
          status: Database["public"]["Enums"]["opportunity_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "market_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "market_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      pages_archive: {
        Row: {
          archived_at: string | null
          client_id: string | null
          created_at: string | null
          id: string | null
          kind: string | null
          publish_status: string | null
          published_url: string | null
          revisions: number | null
          status: string | null
          title: string | null
          was_published: boolean | null
        }
        Insert: {
          archived_at?: string | null
          client_id?: string | null
          created_at?: string | null
          id?: string | null
          kind?: never
          publish_status?: string | null
          published_url?: string | null
          revisions?: never
          status?: never
          title?: string | null
          was_published?: never
        }
        Update: {
          archived_at?: string | null
          client_id?: string | null
          created_at?: string | null
          id?: string | null
          kind?: never
          publish_status?: string | null
          published_url?: string | null
          revisions?: never
          status?: never
          title?: string | null
          was_published?: never
        }
        Relationships: [
          {
            foreignKeyName: "client_pages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      post_copy_effective: {
        Row: {
          alt_text: string | null
          asset_id: string | null
          caption: string | null
          client_id: string | null
          cta: string | null
          first_comment: string | null
          hashtags: string[] | null
          level: string | null
          link_url: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          scheduled_post_id: string | null
          source: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "approvals_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "client_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_attribution"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "publish_due"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scheduled_posts_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "work_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      proof_placement_due: {
        Row: {
          attempts: number | null
          blocker: string | null
          client_id: string | null
          destination_key: string | null
          destination_label: string | null
          expires_on: string | null
          mode: string | null
          payload_hash: string | null
          placement_id: string | null
          source_proof_id: string | null
          source_title: string | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proof_placements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proof_placements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "proof_placements_destination_key_fkey"
            columns: ["destination_key"]
            isOneToOne: false
            referencedRelation: "proof_destinations"
            referencedColumns: ["destination_key"]
          },
          {
            foreignKeyName: "proof_placements_source_proof_id_fkey"
            columns: ["source_proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      publish_due: {
        Row: {
          alt_text: string | null
          asset_id: string | null
          asset_title: string | null
          blocker: string | null
          caption: string | null
          client_id: string | null
          client_name: string | null
          content_format: Database["public"]["Enums"]["content_format"] | null
          first_comment: string | null
          format_supported: boolean | null
          hashtags: string[] | null
          human_approved_at: string | null
          link_url: string | null
          media_path: string | null
          media_type: Database["public"]["Enums"]["media_type"] | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          platform_supported: boolean | null
          post_id: string | null
          provider: string | null
          publication_status: string | null
          publish_attempts: number | null
          publish_claimed_at: string | null
          scheduled_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      sales_agents_archive: {
        Row: {
          approved_at: string | null
          archived_at: string | null
          client_id: string | null
          conversations: number | null
          created_at: string | null
          id: string | null
          kind: string | null
          purpose: string | null
          status: string | null
          title: string | null
        }
        Insert: {
          approved_at?: string | null
          archived_at?: string | null
          client_id?: string | null
          conversations?: never
          created_at?: string | null
          id?: string | null
          kind?: never
          purpose?: string | null
          status?: string | null
          title?: string | null
        }
        Update: {
          approved_at?: string | null
          archived_at?: string | null
          client_id?: string | null
          conversations?: never
          created_at?: string | null
          id?: string | null
          kind?: never
          purpose?: string | null
          status?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_sales_agents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sales_agents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      security_definer_exposure: {
        Row: {
          anon_can_execute: boolean | null
          arguments: string | null
          body_checks_the_caller: boolean | null
          function: unknown
          schema: unknown
          signed_in_can_execute: boolean | null
        }
        Relationships: []
      }
      slot_board: {
        Row: {
          asset_title: string | null
          attempts: number | null
          blocked_reason: string | null
          client_id: string | null
          cost_usd: number | null
          entered_stage_at: string | null
          format: Database["public"]["Enums"]["content_format"] | null
          in_stage_for: string | null
          pillar_name: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          scheduled_at: string | null
          settled: boolean | null
          slot_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"] | null
        }
        Relationships: [
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
        ]
      }
      slot_decisions: {
        Row: {
          chosen_title: string | null
          client_id: string | null
          considered: Json | null
          decided_at: string | null
          kind: string | null
          passed_over: number | null
          reasons: Json | null
          score: number | null
          slot_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "engine_decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "content_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_decisions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slot_board"
            referencedColumns: ["slot_id"]
          },
        ]
      }
      slot_timeline: {
        Row: {
          actor: string | null
          agent_key: string | null
          client_id: string | null
          cost_usd: number | null
          created_at: string | null
          event_id: string | null
          from_stage: Database["public"]["Enums"]["slot_stage"] | null
          note: string | null
          slot_id: string | null
          spent_in_previous: string | null
          to_stage: Database["public"]["Enums"]["slot_stage"] | null
        }
        Relationships: [
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_slots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_inbox"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "approval_queue_slots"
            referencedColumns: ["slot_id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "content_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slot_board"
            referencedColumns: ["slot_id"]
          },
        ]
      }
      work_submissions: {
        Row: {
          client_id: string | null
          created_at: string | null
          id: string | null
          media_type: Database["public"]["Enums"]["media_type"] | null
          member_id: string | null
          ref_number: string | null
          review_status: Database["public"]["Enums"]["review_status"] | null
          storage_path: string | null
          title: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string | null
          id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"] | null
          member_id?: string | null
          ref_number?: string | null
          review_status?: Database["public"]["Enums"]["review_status"] | null
          storage_path?: string | null
          title?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string | null
          id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"] | null
          member_id?: string | null
          ref_number?: string | null
          review_status?: Database["public"]["Enums"]["review_status"] | null
          storage_path?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "engine_readiness"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_media_assets_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      aa_house_client_id: { Args: never; Returns: string }
      accept_assignment: {
        Args: { p_assignment_id: string }
        Returns: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accept_proof_capture_submission: {
        Args: {
          p_body: string
          p_category: string
          p_consent: string
          p_job_reference: string
          p_kind: string
          p_mime: string
          p_name: string
          p_storage_path: string
          p_submission_id: string
          p_token_hash: string
        }
        Returns: string
      }
      accept_ready_daily_workflow_steps: {
        Args: { p_limit?: number }
        Returns: {
          steps_accepted: number
          steps_blocked: number
        }[]
      }
      accept_video_as_finished: {
        Args: { p_asset_id: string }
        Returns: undefined
      }
      accept_workflow_step: {
        Args: {
          p_artifact_kind: string
          p_qa_evidence: Json
          p_record_id: string
          p_step_id: string
          p_version_key: string
        }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accessible_client_ids: { Args: never; Returns: string[] }
      acquisition_funnel: {
        Args: { p_client_id: string; p_days?: number }
        Returns: {
          appointments: number
          cash_collected: number
          conversations: number
          cost_per_lead: number
          followers: number
          lead_to_sale_pct: number
          leads: number
          lost: number
          pipeline_value: number
          profile_visits: number
          qualified: number
          return_on_spend: number
          sale_value: number
          sales: number
          spend: number
        }[]
      }
      active_video_approval_manager: {
        Args: { p_client_id: string }
        Returns: string
      }
      add_engine_window: {
        Args: {
          p_client_id: string
          p_ends_at: string
          p_platform?: Database["public"]["Enums"]["post_platform"]
          p_starts_at: string
          p_weekday: number
        }
        Returns: string
      }
      add_lead_note: {
        Args: { p_lead_id: string; p_note: string }
        Returns: undefined
      }
      add_workflow_agent_step: {
        Args: {
          p_agent_key: string
          p_dependencies: string[]
          p_input_from_step_key?: string
          p_input_id: string
          p_input_params?: Json
          p_input_table: string
          p_run_id: string
          p_step_key: string
        }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_create_team_member: {
        Args: {
          p_category: Database["public"]["Enums"]["team_category"]
          p_engagement?: Database["public"]["Enums"]["engagement_type"]
          p_initials: string
          p_name: string
          p_password?: string
          p_username?: string
        }
        Returns: string
      }
      admin_store_integration_credential: {
        Args: {
          p_access_level?: string
          p_client_id: string
          p_label: string
          p_provider: string
          p_secret: string
        }
        Returns: string
      }
      advance_assignment: {
        Args: {
          p_actor?: string
          p_asset_id?: string
          p_assignment_id: string
          p_reason?: string
          p_to_stage: Database["public"]["Enums"]["assignment_stage"]
        }
        Returns: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      advance_lead: {
        Args: {
          p_lead_id: string
          p_note?: string
          p_stage: Database["public"]["Enums"]["lead_stage"]
        }
        Returns: undefined
      }
      advance_proof_production: { Args: never; Returns: number }
      advance_slot: {
        Args: {
          p_actor?: string
          p_agent_key?: string
          p_asset_id?: string
          p_blocked_reason?: string
          p_brief_id?: string
          p_cost_usd?: number
          p_idea_id?: string
          p_job_id?: string
          p_note?: string
          p_scheduled_post_id?: string
          p_slot_id: string
          p_to_stage: Database["public"]["Enums"]["slot_stage"]
        }
        Returns: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "content_slots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      agent_spend_for_client: {
        Args: { p_client_id: string; p_month?: string }
        Returns: number
      }
      approve_idea_and_generate_brief: {
        Args: { p_idea_id: string }
        Returns: string
      }
      approve_idea_by_policy: {
        Args: {
          p_considered?: Json
          p_idea_id: string
          p_reasons?: Json
          p_score?: number
          p_slot_id: string
        }
        Returns: {
          brief_id: string | null
          client_id: string
          considered: Json
          decided_at: string
          id: string
          idea_id: string | null
          kind: string
          reasons: Json
          score: number | null
          slot_id: string
        }
        SetofOptions: {
          from: "*"
          to: "engine_decisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_proof_artifact_v6: {
        Args: { p_artifact_version_id: string }
        Returns: {
          approved_at: string
          approved_by: string
          artifact_version_id: string
          client_id: string
        }
        SetofOptions: {
          from: "*"
          to: "proof_artifact_signoffs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_recruitment_brief: {
        Args: { p_brief_id: string }
        Returns: undefined
      }
      approve_service_offer_version_v6: {
        Args: { p_version_id: string }
        Returns: {
          approved_at: string
          approved_by: string
          client_id: string
          offer_version_id: string
        }
        SetofOptions: {
          from: "*"
          to: "service_offer_signoffs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_slot: {
        Args: { p_note?: string; p_slot_id: string }
        Returns: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "content_slots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      archive_lead: {
        Args: { p_lead_id: string; p_reason?: string }
        Returns: undefined
      }
      assert_page_publish_allowed_v6: {
        Args: { p_page_id: string }
        Returns: undefined
      }
      attach_campaign_manifest_intelligence_v6: {
        Args: { p_manifest_id: string; p_snapshot_id: string }
        Returns: undefined
      }
      attach_campaign_offer_v6: {
        Args: { p_manifest_id: string; p_offer_version_id: string }
        Returns: undefined
      }
      attach_motion_design: {
        Args: { p_brief_id?: string; p_project_id: string }
        Returns: string
      }
      attest_video_sound_asset: {
        Args: {
          p_client_id: string
          p_kind: string
          p_rights_reference: string
          p_storage_path: string
        }
        Returns: {
          attested_at: string
          attested_by: string
          client_id: string
          created_at: string
          id: string
          kind: string
          rights_reference: string
          storage_path: string
        }
        SetofOptions: {
          from: "*"
          to: "video_sound_assets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      auto_rebuild_rejected_reel_sources: {
        Args: { p_limit?: number }
        Returns: number
      }
      brief_video_repurpose_candidate: {
        Args: {
          p_candidate_index: number
          p_request_id: string
          p_target_platform: Database["public"]["Enums"]["post_platform"]
        }
        Returns: string
      }
      build_brief_with_ai: {
        Args: {
          p_brief_id: string
          p_frame_count?: number
          p_frame_plan?: string[]
          p_quality?: string
          p_reference_path?: string
          p_size?: string
        }
        Returns: string
      }
      caller_gate_markers: { Args: never; Returns: string }
      campaign_readiness: {
        Args: { p_campaign_id: string }
        Returns: {
          detail: string
          have: number
          met: boolean
          required: number
          requirement: string
        }[]
      }
      can_access_client: { Args: { target: string }; Returns: boolean }
      can_run_agent: {
        Args: { p_agent_key: string; p_client_id: string }
        Returns: boolean
      }
      can_shape_opportunity: { Args: { p_client_id: string }; Returns: boolean }
      cancel_assignment: {
        Args: { p_assignment_id: string; p_reason?: string }
        Returns: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      capture_campaign_artifact_offer_v6: {
        Args: { p_artifact_kind: string; p_job_id: string }
        Returns: Json
      }
      capture_campaign_intelligence_snapshot_v6: {
        Args: { p_campaign_id: string; p_job_id: string }
        Returns: {
          acquisition_mode: string
          brief: string
          business_context: Json
          campaign_id: string
          captured_at: string
          client_id: string
          content_pillars: Json
          id: string
          missing_domains: string[]
          paid_platform: string | null
          planner_job_id: string
          snapshot_hash: string
          source_records: Json
        }
        SetofOptions: {
          from: "*"
          to: "campaign_intelligence_snapshots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      capture_campaign_offer_v6: {
        Args: { p_campaign_id: string }
        Returns: Json
      }
      capture_ideation_learning_context: {
        Args: { p_job_id: string }
        Returns: Json
      }
      capture_offer_version_for_artifact_v6: {
        Args: { p_campaign_id: string; p_offer_version_id: string }
        Returns: Json
      }
      capture_sales_agent_lead: {
        Args: { p_conversation_id: string; p_opportunity_value?: number }
        Returns: string
      }
      chat_participants: {
        Args: never
        Returns: {
          display_name: string
          id: string
        }[]
      }
      claim_agent_job: {
        Args: {
          p_agent_keys?: string[]
          p_lease_owner: string
          p_lease_seconds?: number
        }
        Returns: {
          agent_key: string
          attempts: number
          client_id: string | null
          completed_at: string | null
          cost_usd: number
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          input_id: string | null
          input_table: string | null
          input_tokens: number
          lease_owner: string | null
          lease_until: string | null
          max_attempts: number
          output_tokens: number
          params: Json
          run_after: string | null
          run_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          terminal: boolean
        }
        SetofOptions: {
          from: "*"
          to: "agent_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_daily_recovery_alert: {
        Args: { p_lease_seconds?: number; p_worker: string }
        Returns: {
          alert_id: string
          client_id: string
          client_name: string
          item_id: string
          item_role: string
          manager_email: string
          package_day: string
          reason: string
        }[]
      }
      claim_posts_for_publishing: {
        Args: { p_limit?: number }
        Returns: {
          alt_text: string
          asset_id: string
          attempt: number
          caption: string
          client_id: string
          content_format: Database["public"]["Enums"]["content_format"]
          first_comment: string
          frame_paths: string[]
          hashtags: string[]
          link_url: string
          media_path: string
          media_type: Database["public"]["Enums"]["media_type"]
          platform: Database["public"]["Enums"]["post_platform"]
          post_id: string
          provider: string
          scheduled_at: string
        }[]
      }
      claim_proof_delivery: {
        Args: never
        Returns: {
          approved_at: string | null
          approved_by: string | null
          attempts: number
          capture_url: string
          channel: string
          client_id: string
          config_id: string
          created_at: string
          error: string | null
          event_key: string
          id: string
          lease_until: string | null
          link_id: string
          message: string
          provider_id: string | null
          recipient: string
          scheduled_at: string
          sent_at: string | null
          status: string
          subject: string
          template_sid: string | null
          template_variables: Json | null
        }
        SetofOptions: {
          from: "*"
          to: "proof_request_deliveries"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_proof_placements: {
        Args: { p_limit?: number }
        Returns: {
          account_ref: string
          artifact_version_id: string
          asset_id: string
          attempt: number
          client_id: string
          destination_key: string
          payload_hash: string
          placement_id: string
          proof_id: string
          provider: string
        }[]
      }
      client_budget_state: {
        Args: { p_client_id: string; p_month?: string }
        Returns: {
          cap_usd: number
          capped: boolean
          remaining_usd: number
          spent_usd: number
        }[]
      }
      client_economics: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: {
          appointments: number
          avg_customer_value: number
          cac: number
          cash_collected: number
          cash_roas: number
          cpa: number
          cpl: number
          cpql: number
          currency: string
          customers: number
          followers: number
          leads: number
          mixed_currency: boolean
          profile_visits: number
          qualified: number
          qualified_leads: number
          revenue: number
          revenue_per_lead: number
          roas: number
          spend: number
        }[]
      }
      client_economics_by_campaign: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: {
          cac: number
          campaign_id: string
          campaign_ref: string
          cash_collected: number
          cpl: number
          customers: number
          followers: number
          leads: number
          profile_visits: number
          qualified: number
          revenue: number
          roas: number
          spend: number
        }[]
      }
      client_economics_by_channel: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: {
          cac: number
          cash_collected: number
          channel: string
          cpl: number
          customers: number
          followers: number
          leads: number
          profile_visits: number
          qualified: number
          revenue: number
          roas: number
          spend: number
        }[]
      }
      client_timezone: { Args: { p_client_id: string }; Returns: string }
      clone_campaign_for_route: {
        Args: {
          p_name?: string
          p_paid_platform?: string
          p_source_campaign_id: string
          p_target_mode: string
        }
        Returns: string
      }
      complete_daily_recovery_alert: {
        Args: {
          p_alert_id: string
          p_error?: string
          p_provider_message_id?: string
          p_sent: boolean
          p_worker: string
        }
        Returns: {
          created_at: string
          delivered_at: string | null
          delivery_attempts: number
          delivery_error: string | null
          delivery_lease_until: string | null
          delivery_status: string
          delivery_worker: string | null
          id: string
          item_id: string
          provider_message_id: string | null
          reason: string
          resolved_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "daily_package_recovery_alerts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_repurpose_clip: {
        Args: {
          p_duration_sec: number
          p_request_id: string
          p_storage_path: string
        }
        Returns: string
      }
      complete_source_video_edit: {
        Args: {
          p_duration_sec: number
          p_edit_plan: Json
          p_height: number
          p_request_id: string
          p_storage_path: string
          p_width: number
        }
        Returns: string
      }
      compose_recruitment_body: {
        Args: {
          p_apply_url: string
          p_call_to_action: string
          p_compensation_text: string
          p_hook: string
          p_premise: string
          p_script: string
          p_visual_direction: string
        }
        Returns: string
      }
      create_campaign_manifest_v6: {
        Args: {
          p_campaign_id: string
          p_idempotency_key: string
          p_needs_lead_magnet?: boolean
        }
        Returns: {
          acquisition_mode: string
          campaign_id: string
          client_id: string
          created_at: string
          id: string
          idempotency_key: string
          paid_platform: string | null
          plan_hash: string
          plan_snapshot: Json
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "campaign_manifest_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_console_user: {
        Args: {
          p_category?: Database["public"]["Enums"]["team_category"]
          p_email: string
          p_full_name: string
          p_password: string
          p_role: Database["public"]["Enums"]["app_role"]
        }
        Returns: string
      }
      create_content_slot: {
        Args: {
          p_client_id: string
          p_format?: Database["public"]["Enums"]["content_format"]
          p_pillar_id?: string
          p_platform: Database["public"]["Enums"]["post_platform"]
          p_scheduled_at: string
        }
        Returns: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "content_slots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_market_opportunity_v6: {
        Args: {
          p_buying_situation: string
          p_client_id: string
          p_conversion_action?: string
          p_core_problem?: string
          p_desired_outcome?: string
          p_entry_awareness?: string
          p_idempotency_key: string
          p_job_id?: string
          p_micro_market: string
          p_name: string
          p_positioning?: string
          p_proposed_by?: string
          p_purchase_trigger?: string
        }
        Returns: string
      }
      create_proof_artifact_v6: {
        Args: {
          p_artifact_kind: string
          p_client_id: string
          p_content: string
          p_evidence_excerpt: string
          p_idempotency_key: string
          p_job_id?: string
          p_source_proof_id: string
          p_supported_claim: string
        }
        Returns: {
          artifact_kind: string
          client_id: string
          content: string
          content_hash: string
          created_at: string
          created_by_job_id: string | null
          evidence_excerpt: string
          id: string
          idempotency_key: string
          source_hash: string
          source_proof_id: string
          source_snapshot: Json
          supported_claim: string
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "proof_artifact_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_proof_placement_v6: {
        Args: {
          p_artifact_version_id?: string
          p_asset_id?: string
          p_campaign_id?: string
          p_client_id: string
          p_destination_key: string
          p_idempotency_key: string
          p_production_request_id?: string
          p_proof_id?: string
        }
        Returns: string
      }
      create_recruitment_brief: {
        Args: {
          p_apply_url: string
          p_call_to_action: string
          p_compensation_text?: string
          p_hook: string
          p_premise?: string
          p_role: Database["public"]["Enums"]["recruitment_role"]
          p_script: string
          p_title: string
          p_visual_direction?: string
        }
        Returns: string
      }
      create_recruitment_meta_campaign: {
        Args: {
          p_asset_ids: string[]
          p_daily_budget: number
          p_name: string
          p_target_countries: string[]
        }
        Returns: string
      }
      create_service_offer_version_v6: {
        Args: {
          p_audience: string
          p_claims: Json
          p_client_id: string
          p_currency: string
          p_delivery_cost_estimate: number
          p_exclusions: string[]
          p_idempotency_key: string
          p_inclusions: string[]
          p_offer_id?: string
          p_price_amount: number
          p_promise: string
          p_service_name: string
        }
        Returns: {
          audience: string
          claims: Json
          client_id: string
          content_hash: string
          created_at: string
          currency: string | null
          delivery_cost_estimate: number | null
          exclusions: string[]
          id: string
          idempotency_key: string
          inclusions: string[]
          offer_id: string
          price_amount: number | null
          promise: string
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "service_offer_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_video_repurpose_idea: {
        Args: {
          p_candidate_index: number
          p_request_id: string
          p_target_platform: Database["public"]["Enums"]["post_platform"]
        }
        Returns: string
      }
      create_workflow_run: {
        Args: {
          p_campaign_id?: string
          p_client_id: string
          p_created_by?: string
          p_deadline_at: string
          p_idempotency_key: string
          p_input_snapshot: Json
          p_kind: string
          p_root_request_id?: string
          p_workflow_version: string
        }
        Returns: {
          blocker: string | null
          campaign_id: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          deadline_at: string
          id: string
          idempotency_key: string
          input_snapshot: Json
          kind: string
          review_ready_at: string | null
          root_request_id: string | null
          sealed_at: string | null
          status: string
          updated_at: string
          workflow_version: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_member_id: { Args: never; Returns: string }
      current_role_of: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      daily_package_readiness: { Args: { p_package_id: string }; Returns: Json }
      daily_reserve_coverage: {
        Args: { p_client_id: string }
        Returns: {
          available: number
          role: string
          shortfall: number
          target: number
        }[]
      }
      decide_campaign_action_approval_v6: {
        Args: { p_decision: string; p_reason?: string; p_request_id: string }
        Returns: {
          action_key: string
          artifact_version_hash: string
          campaign_id: string
          client_id: string
          decided_at: string | null
          decided_by: string | null
          destination: string
          id: string
          idempotency_key: string
          manifest_id: string
          rejection_reason: string | null
          request_hash: string
          requested_at: string
          scope: Json
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "campaign_action_approvals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decide_proof_delivery: {
        Args: { p_approve: boolean; p_delivery_id: string }
        Returns: undefined
      }
      decide_proof_placement_approval_v6: {
        Args: { p_approval_id: string; p_approved: boolean; p_reason?: string }
        Returns: {
          approval_id: string | null
          artifact_version_id: string | null
          asset_id: string | null
          attempts: number
          bound_revision_id: string | null
          bound_version_hash: string | null
          campaign_id: string | null
          claimed_at: string | null
          client_id: string
          created_at: string
          created_by: string | null
          destination_key: string
          external_id: string | null
          external_url: string | null
          id: string
          idempotency_key: string
          last_error: string | null
          lease_until: string | null
          payload_hash: string
          placed_at: string | null
          placed_by: string | null
          production_request_id: string | null
          proof_id: string | null
          retracted_at: string | null
          source_proof_id: string
          status: string
          updated_at: string
          verified_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "proof_placements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decide_video_render_candidate: {
        Args: {
          p_candidate_id: string
          p_creative_review: Json
          p_edit_plan?: Json
          p_rejection_reason?: string
          p_verdict: string
        }
        Returns: {
          asset_id: string
          attempt: number
          client_id: string
          created_at: string
          creative_review: Json | null
          edit_plan: Json | null
          id: string
          job_id: string
          media_probe: Json
          rejection_reason: string | null
          render_path: string
          reviewed_at: string | null
          verdict: string
        }
        SetofOptions: {
          from: "*"
          to: "video_render_candidates"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_assignment: {
        Args: { p_assignment_id: string; p_reason: string }
        Returns: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_video_client_approval: {
        Args: { p_asset_id: string; p_reason: string }
        Returns: undefined
      }
      default_post_time: { Args: never; Returns: string }
      delete_client_campaign: {
        Args: { p_campaign_id: string }
        Returns: {
          deleted_assets: number
          deleted_briefs: number
          deleted_ideas: number
        }[]
      }
      delete_client_idea: {
        Args: { p_idea_id: string }
        Returns: {
          deleted_assets: number
          deleted_briefs: number
        }[]
      }
      delete_content_asset_v6: {
        Args: { p_asset_id: string }
        Returns: {
          deleted_copy: number
          deleted_files: number
          deleted_frames: number
          deleted_posts: number
        }[]
      }
      delete_content_brief_v6: {
        Args: { p_brief_id: string }
        Returns: {
          deleted_copy: number
          deleted_files: number
          deleted_frames: number
          deleted_posts: number
        }[]
      }
      delete_recruitment_ad: {
        Args: { p_brief_id: string }
        Returns: {
          deleted_assets: number
        }[]
      }
      deliver_assignment: {
        Args: { p_asset_id: string; p_assignment_id: string }
        Returns: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      dispatch_brief_to_members: {
        Args: {
          p_brief_id: string
          p_brief_role?: string
          p_compensation?: number
          p_due_date?: string
          p_member_ids: string[]
        }
        Returns: number
      }
      engine_is_enabled: { Args: { p_client_id: string }; Returns: boolean }
      engine_jobs_in_flight: { Args: { p_client_id: string }; Returns: number }
      engine_tick: {
        Args: { p_now?: string }
        Returns: {
          clients_considered: number
          clients_skipped: number
          finished_at: string | null
          id: string
          jobs_queued: number
          notes: Json
          slots_planned: number
          started_at: string
        }
        SetofOptions: {
          from: "*"
          to: "engine_tick_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      enqueue_agent_job: {
        Args: {
          p_agent_key: string
          p_client_id?: string
          p_input_id?: string
          p_input_table?: string
        }
        Returns: string
      }
      enqueue_agent_job_as: {
        Args: {
          p_actor: string
          p_agent_key: string
          p_client_id?: string
          p_input_id?: string
          p_input_table?: string
        }
        Returns: string
      }
      enqueue_agent_job_internal: {
        Args: {
          p_actor: string
          p_agent_key: string
          p_client_id: string
          p_description?: string
          p_input_id: string
          p_input_table: string
          p_params?: Json
        }
        Returns: string
      }
      enqueue_format_ideation: {
        Args: {
          p_client_id: string
          p_content_format: Database["public"]["Enums"]["content_format"]
          p_media_type: Database["public"]["Enums"]["media_type"]
          p_target_platform: Database["public"]["Enums"]["post_platform"]
        }
        Returns: string
      }
      enqueue_mcp_brief: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_idea_id: string
          p_request_id: string
        }
        Returns: Json
      }
      enqueue_metrics_ingest_jobs: {
        Args: { p_days?: number }
        Returns: number
      }
      enqueue_publish_sweep: { Args: never; Returns: string }
      enqueue_scoped_ideation: {
        Args: {
          p_campaign_id: string
          p_client_id: string
          p_content_format: Database["public"]["Enums"]["content_format"]
          p_idea_count: number
          p_input_id: string
          p_input_table: string
          p_media_type: Database["public"]["Enums"]["media_type"]
          p_target_platform: Database["public"]["Enums"]["post_platform"]
        }
        Returns: string
      }
      enqueue_token_health_job: { Args: never; Returns: string }
      enqueue_workflow_step_job: {
        Args: {
          p_resolved_input: string
          p_run: Database["public"]["Tables"]["workflow_runs"]["Row"]
          p_step: Database["public"]["Tables"]["workflow_steps"]["Row"]
        }
        Returns: string
      }
      fail_source_video_edit: {
        Args: { p_error: string; p_request_id: string }
        Returns: undefined
      }
      format_fits_media: {
        Args: {
          p_format: Database["public"]["Enums"]["content_format"]
          p_media: Database["public"]["Enums"]["media_type"]
        }
        Returns: boolean
      }
      frame_plan_is_usable: { Args: { p_plan: string[] }; Returns: boolean }
      generate_recruitment_ad: {
        Args: { p_brief_id: string; p_quality?: string; p_size?: string }
        Returns: Json
      }
      intake_video_for_edit: {
        Args: {
          p_asset_id: string
          p_brief_id?: string
          p_client_id: string
          p_format: Database["public"]["Enums"]["content_format"]
          p_notes?: string
          p_rights: string
          p_source: string
          p_storage_path: string
          p_title: string
        }
        Returns: Json
      }
      integration_secret: {
        Args: { p_client_id: string; p_provider: string }
        Returns: string
      }
      integration_usable: {
        Args: { p_client_id: string; p_provider: string }
        Returns: boolean
      }
      is_active_assigned_smm: { Args: never; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_channel_member: { Args: { target: string }; Returns: boolean }
      is_client_user: { Args: { target: string }; Returns: boolean }
      is_member: { Args: { target: string }; Returns: boolean }
      launch_campaign: { Args: { p_campaign_id: string }; Returns: undefined }
      lead_stage_rank: {
        Args: { s: Database["public"]["Enums"]["lead_stage"] }
        Returns: number
      }
      link_opportunity_v6: {
        Args: { p_opportunity_id: string; p_role: string; p_target_id: string }
        Returns: string
      }
      lock_down_definer_functions: { Args: never; Returns: number }
      mark_proof_placement_placed_v6: {
        Args: { p_external_url: string; p_placement_id: string }
        Returns: undefined
      }
      master_ai_describe_table: {
        Args: { p_table: string }
        Returns: {
          column_default: string
          column_name: string
          data_type: string
          is_nullable: string
        }[]
      }
      master_ai_spend: {
        Args: { p_conversation_id?: string }
        Returns: {
          conversation_usd: number
          day_usd: number
        }[]
      }
      master_run_progress: {
        Args: { p_run_id: string }
        Returns: {
          completed: number
          cost_usd: number
          failed: number
          queued: number
          running: number
          total: number
        }[]
      }
      max_backfill_days: { Args: never; Returns: number }
      may_advance_slot: { Args: { p_client_id: string }; Returns: boolean }
      may_touch_assignment: { Args: { p_member_id: string }; Returns: boolean }
      mcp_admin_create_event: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_ends_at: string
          p_event_type: string
          p_execution_id: string
          p_notes: string
          p_request_id: string
          p_starts_at: string
          p_title: string
        }
        Returns: Json
      }
      mcp_admin_get_event: {
        Args: { p_bot_id: string; p_client_id: string; p_event_id: string }
        Returns: Json
      }
      mcp_admin_list_events: {
        Args: {
          p_after?: string
          p_bot_id: string
          p_client_id: string
          p_due_before?: string
          p_limit?: number
          p_status?: string
        }
        Returns: Json
      }
      mcp_admin_update_event: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_ends_at: string
          p_event_id: string
          p_execution_id: string
          p_expected_version: number
          p_notes: string
          p_request_id: string
          p_starts_at: string
          p_status: string
          p_title: string
        }
        Returns: Json
      }
      mcp_approve_asset: {
        Args: {
          p_asset_id: string
          p_bot_id: string
          p_client_id: string
          p_decision: string
          p_execution_id: string
          p_reason?: string
          p_request_id: string
        }
        Returns: Json
      }
      mcp_approve_idea: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_idea_id: string
          p_request_id: string
        }
        Returns: Json
      }
      mcp_assign_production: {
        Args: {
          p_bot_id: string
          p_brief_id: string
          p_brief_role?: string
          p_client_id: string
          p_compensation?: number
          p_due_date?: string
          p_execution_id: string
          p_member_ids?: string[]
          p_quality?: string
          p_request_id: string
          p_route: string
          p_size?: string
        }
        Returns: Json
      }
      mcp_attach_sales_agent_to_page: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_page_id: string
          p_request_id: string
          p_sales_agent_id: string
        }
        Returns: Json
      }
      mcp_attribution_content_performance: {
        Args: { p_bot_id: string; p_client_id: string; p_limit?: number }
        Returns: Json
      }
      mcp_attribution_conversion_funnel: {
        Args: { p_bot_id: string; p_client_id: string; p_days?: number }
        Returns: Json
      }
      mcp_attribution_revenue: {
        Args: {
          p_bot_id: string
          p_campaign_id?: string
          p_client_id: string
          p_end_date?: string
          p_limit?: number
          p_start_date?: string
        }
        Returns: Json
      }
      mcp_brand_get_profile: {
        Args: { p_bot_id: string; p_client_id: string }
        Returns: Json
      }
      mcp_build_sales_agent: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_request_id: string
          p_sales_agent_id: string
        }
        Returns: Json
      }
      mcp_campaign_create_v6:
        | {
            Args: {
              p_acquisition_mode: string
              p_bot_id: string
              p_brief: string
              p_client_id: string
              p_execution_id: string
              p_name: string
              p_paid_platform: string
              p_request_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_acquisition_mode: string
              p_bot_id: string
              p_brief: string
              p_client_id: string
              p_execution_id: string
              p_name: string
              p_offer_version_id: string
              p_paid_platform: string
              p_request_id: string
            }
            Returns: Json
          }
      mcp_campaign_execution: {
        Args: {
          p_action: string
          p_after?: string
          p_bot_id: string
          p_brief?: string
          p_campaign_id?: string
          p_client_id: string
          p_execution_id?: string
          p_kind?: string
          p_limit?: number
          p_name?: string
          p_request_id?: string
          p_status?: string
          p_summary?: string
        }
        Returns: Json
      }
      mcp_campaign_list_v6: {
        Args: {
          p_after?: string
          p_bot_id: string
          p_client_id: string
          p_limit?: number
        }
        Returns: Json
      }
      mcp_campaign_read: {
        Args: {
          p_action: string
          p_after?: string
          p_bot_id: string
          p_campaign_id?: string
          p_client_id: string
          p_end_date?: string
          p_limit?: number
          p_start_date?: string
        }
        Returns: Json
      }
      mcp_conversion: {
        Args: {
          p_action: string
          p_after?: string
          p_bot_id: string
          p_brief?: string
          p_campaign_id?: string
          p_client_id: string
          p_execution_id?: string
          p_finding_ids?: string[]
          p_limit?: number
          p_page_id?: string
          p_page_type?: string
          p_request_id?: string
          p_revision_number?: number
          p_summary?: string
          p_title?: string
        }
        Returns: Json
      }
      mcp_create_followup: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_lead_id: string
          p_next_action: string
          p_next_action_due?: string
          p_request_id: string
        }
        Returns: Json
      }
      mcp_create_repurpose_plan: {
        Args: {
          p_asset_id: string
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_formats: string[]
          p_request_id: string
        }
        Returns: Json
      }
      mcp_create_sales_agent: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_name: string
          p_purpose: string
          p_request_id: string
          p_role: string
        }
        Returns: Json
      }
      mcp_create_upload_url: {
        Args: {
          p_bot_id: string
          p_brief_id: string
          p_byte_size?: number
          p_client_id: string
          p_content_type: string
          p_execution_id: string
          p_filename?: string
          p_request_id: string
        }
        Returns: Json
      }
      mcp_delivery_create_task: {
        Args: {
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_due_date?: string
          p_execution_id: string
          p_request_id: string
          p_summary?: string
          p_title: string
        }
        Returns: Json
      }
      mcp_delivery_list_clients: {
        Args: { p_after?: string; p_bot_id: string; p_limit?: number }
        Returns: Json
      }
      mcp_delivery_read: {
        Args: { p_bot_id: string; p_client_id: string; p_view: string }
        Returns: Json
      }
      mcp_economics_read: {
        Args: {
          p_action: string
          p_bot_id: string
          p_campaign_id?: string
          p_client_id: string
          p_end_date?: string
          p_limit?: number
          p_start_date?: string
        }
        Returns: Json
      }
      mcp_engineering_create_issue: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_notes: string
          p_request_id: string
          p_title: string
        }
        Returns: Json
      }
      mcp_engineering_get_deployment_status: {
        Args: {
          p_after?: string
          p_bot_id: string
          p_client_id: string
          p_job_id?: string
          p_limit?: number
        }
        Returns: Json
      }
      mcp_engineering_get_issue: {
        Args: { p_bot_id: string; p_client_id: string; p_issue_id: string }
        Returns: Json
      }
      mcp_engineering_get_release_status: {
        Args: {
          p_after?: string
          p_bot_id: string
          p_client_id: string
          p_limit?: number
          p_page_id?: string
        }
        Returns: Json
      }
      mcp_generate_sales_agent_config: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_request_id: string
          p_role: string
        }
        Returns: Json
      }
      mcp_get_brief: {
        Args: {
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_idea_id?: string
        }
        Returns: Json
      }
      mcp_get_idea: {
        Args: { p_bot_id: string; p_client_id: string; p_idea_id: string }
        Returns: Json
      }
      mcp_get_lead: {
        Args: { p_bot_id: string; p_client_id: string; p_lead_id: string }
        Returns: Json
      }
      mcp_get_pipeline_summary: {
        Args: { p_bot_id: string; p_client_id: string }
        Returns: Json
      }
      mcp_get_production_status: {
        Args: {
          p_asset_id?: string
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_idea_id?: string
        }
        Returns: Json
      }
      mcp_get_sales_agent: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_sales_agent_id: string
        }
        Returns: Json
      }
      mcp_get_sales_agent_conversations: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_limit?: number
          p_sales_agent_id?: string
        }
        Returns: Json
      }
      mcp_get_stalled_leads: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_days?: number
          p_limit?: number
        }
        Returns: Json
      }
      mcp_issue_bot_token: {
        Args: {
          p_actor: string
          p_bot_id: string
          p_expires_at?: string
          p_label?: string
          p_token_hash: string
        }
        Returns: Json
      }
      mcp_list_bot_clients: { Args: { p_bot_id: string }; Returns: Json }
      mcp_list_ideas: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_limit?: number
          p_status?: string
        }
        Returns: Json
      }
      mcp_list_leads: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_limit?: number
          p_stage?: string
        }
        Returns: Json
      }
      mcp_list_sales_agents: {
        Args: { p_bot_id: string; p_client_id: string; p_limit?: number }
        Returns: Json
      }
      mcp_proof_attach_asset: {
        Args: {
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_execution_id: string
          p_proof_id: string
          p_request_id: string
          p_storage_path: string
        }
        Returns: Json
      }
      mcp_proof_create: {
        Args: {
          p_avatar_relevance?: string
          p_body?: string
          p_bot_id: string
          p_claim?: string
          p_client_id: string
          p_evidence?: string
          p_execution_id: string
          p_media_type: string
          p_proof_type?: string
          p_request_id: string
          p_source?: string
          p_storage_path?: string
          p_strength?: string
          p_title?: string
        }
        Returns: Json
      }
      mcp_proof_get: {
        Args: { p_bot_id: string; p_client_id: string; p_proof_id: string }
        Returns: Json
      }
      mcp_proof_get_for_avatar: {
        Args: {
          p_avatar: string
          p_bot_id: string
          p_client_id: string
          p_limit?: number
        }
        Returns: Json
      }
      mcp_proof_get_for_claim: {
        Args: {
          p_bot_id: string
          p_claim: string
          p_client_id: string
          p_limit?: number
        }
        Returns: Json
      }
      mcp_proof_search: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_limit?: number
          p_media_type?: string
          p_proof_type?: string
          p_q?: string
        }
        Returns: Json
      }
      mcp_queue_distribution: {
        Args: {
          p_asset_id: string
          p_bot_id: string
          p_channel?: string
          p_client_id: string
          p_execution_id: string
          p_request_id: string
          p_scheduled_for: string
          p_scheduled_time?: string
        }
        Returns: Json
      }
      mcp_record_publication: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_external_id?: string
          p_failure_reason?: string
          p_request_id: string
          p_schedule_id: string
          p_status: string
        }
        Returns: Json
      }
      mcp_request_approval: {
        Args: {
          p_asset_id?: string
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_execution_id: string
          p_idea_id?: string
          p_request_id: string
          p_summary?: string
        }
        Returns: Json
      }
      mcp_request_revision: {
        Args: {
          p_asset_id?: string
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_execution_id: string
          p_idea_id?: string
          p_request_id: string
          p_summary?: string
        }
        Returns: Json
      }
      mcp_resolve_bot_token: { Args: { p_token_hash: string }; Returns: Json }
      mcp_resume_approval: {
        Args: {
          p_approval_execution_id: string
          p_asset_id: string
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_formats: string[]
          p_request_id: string
        }
        Returns: Json
      }
      mcp_revoke_bot_token: {
        Args: { p_actor: string; p_reason?: string; p_token_hash: string }
        Returns: Json
      }
      mcp_rotate_bot_token: {
        Args: {
          p_actor: string
          p_label?: string
          p_new_token_hash: string
          p_old_token_hash: string
        }
        Returns: Json
      }
      mcp_security_create_finding: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_kind: string
          p_notes: string
          p_request_id: string
          p_severity: string
          p_title: string
        }
        Returns: Json
      }
      mcp_security_get_incident_status: {
        Args: {
          p_after?: string
          p_bot_id: string
          p_client_id: string
          p_incident_id?: string
          p_limit?: number
        }
        Returns: Json
      }
      mcp_security_get_open_findings: {
        Args: {
          p_after?: string
          p_bot_id: string
          p_client_id: string
          p_finding_id?: string
          p_limit?: number
        }
        Returns: Json
      }
      mcp_security_get_system_status: {
        Args: { p_bot_id: string; p_client_id: string }
        Returns: Json
      }
      mcp_set_sales_agent_deployment_enabled: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_deployment_id: string
          p_enabled: boolean
          p_execution_id: string
          p_request_id: string
        }
        Returns: Json
      }
      mcp_sites_authorize: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_page_id?: string
          p_tool: string
        }
        Returns: Json
      }
      mcp_submit_asset: {
        Args: {
          p_assignment_id?: string
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_execution_id: string
          p_media_type: string
          p_request_id: string
          p_storage_path: string
          p_title?: string
        }
        Returns: Json
      }
      mcp_submit_uploaded_asset: {
        Args: {
          p_assignment_id?: string
          p_bot_id: string
          p_brief_id?: string
          p_client_id: string
          p_execution_id: string
          p_media_type?: string
          p_pending_asset_id?: string
          p_request_id: string
          p_storage_path?: string
          p_title?: string
        }
        Returns: Json
      }
      mcp_suspend_bot: {
        Args: { p_actor: string; p_bot_id: string; p_reason?: string }
        Returns: Json
      }
      mcp_test_sales_agent: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_request_id: string
          p_sales_agent_id: string
          p_transcript: Json
        }
        Returns: Json
      }
      mcp_update_lead_stage: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_lead_id: string
          p_note?: string
          p_request_id: string
          p_stage: string
        }
        Returns: Json
      }
      mcp_update_sales_agent_knowledge: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_greeting?: string
          p_guardrails?: string
          p_objections?: Json
          p_request_id: string
          p_sales_agent_id: string
        }
        Returns: Json
      }
      mcp_update_sales_agent_qualification_rules: {
        Args: {
          p_bot_id: string
          p_client_id: string
          p_execution_id: string
          p_qualification: Json
          p_request_id: string
          p_sales_agent_id: string
        }
        Returns: Json
      }
      mcp_workflow_task: {
        Args: {
          p_action: string
          p_after?: string
          p_assignee?: string
          p_bot_id: string
          p_client_id: string
          p_execution_id?: string
          p_limit?: number
          p_request_id?: string
          p_summary?: string
          p_task_id?: string
          p_title?: string
        }
        Returns: Json
      }
      metrics_period_summary: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: Json
      }
      my_account_team: {
        Args: never
        Returns: {
          category: string
          name: string
        }[]
      }
      next_ref_number: { Args: { p_client_id: string }; Returns: string }
      pause_agent_job: {
        Args: { p_job_id: string; p_reason: string }
        Returns: {
          agent_key: string
          attempts: number
          client_id: string | null
          completed_at: string | null
          cost_usd: number
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          input_id: string | null
          input_table: string | null
          input_tokens: number
          lease_owner: string | null
          lease_until: string | null
          max_attempts: number
          output_tokens: number
          params: Json
          run_after: string | null
          run_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          terminal: boolean
        }
        SetofOptions: {
          from: "*"
          to: "agent_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      plan_daily_package: {
        Args: { p_client_id: string; p_day: string }
        Returns: {
          client_id: string
          created_at: string
          cutoff_at: string
          id: string
          package_day: string
          platform: Database["public"]["Enums"]["post_platform"]
          run_id: string
          story_media_type: Database["public"]["Enums"]["media_type"]
        }
        SetofOptions: {
          from: "*"
          to: "daily_packages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      plan_slots: {
        Args: { p_client_id: string; p_now?: string }
        Returns: {
          capped: boolean
          created: number
          skipped: number
        }[]
      }
      preview_slots: {
        Args: { p_client_id: string; p_days?: number; p_now?: string }
        Returns: {
          at: string
          local_time: string
          platform: Database["public"]["Enums"]["post_platform"]
          taken: boolean
        }[]
      }
      proof_placement_payload_hash_v6: {
        Args: {
          p_artifact_version_id: string
          p_asset_id: string
          p_destination_key: string
          p_proof_id: string
        }
        Returns: string
      }
      proof_snapshot_hash_v6: { Args: { p: Json }; Returns: string }
      proof_source_snapshot_v6: {
        Args: { p: Database["public"]["Tables"]["client_proof_assets"]["Row"] }
        Returns: Json
      }
      provision_campaign: {
        Args: { p_campaign_id: string }
        Returns: {
          artifact_id: string
          created: string
        }[]
      }
      provision_campaign_artifact: {
        Args: { p_campaign_id: string; p_kind: string }
        Returns: {
          artifact_id: string
          created: string
        }[]
      }
      reap_stale_publish_claims: {
        Args: { p_older_than?: string }
        Returns: number
      }
      reassign_assignment: {
        Args: {
          p_assignment_id: string
          p_member_id: string
          p_reason?: string
        }
        Returns: {
          accepted_at: string | null
          asset_id: string | null
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          due_date: string | null
          id: string
          member_id: string
          source_asset_id: string | null
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reconcile_workflow_runs: {
        Args: { p_limit?: number }
        Returns: {
          steps_blocked: number
          steps_for_qa: number
          steps_queued: number
        }[]
      }
      record_client_launch_asset_check: {
        Args: { p_asset_id: string; p_package_id: string; p_qa_evidence: Json }
        Returns: {
          asset_id: string
          checked_at: string
          package_id: string
          qa_evidence: Json
        }
        SetofOptions: {
          from: "*"
          to: "client_launch_asset_checks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_client_launch_check: {
        Args: {
          p_check_key: string
          p_evidence: Json
          p_package_id: string
          p_record_id: string
        }
        Returns: {
          blocker: string | null
          check_key: string
          checked_at: string | null
          evidence: Json
          package_id: string
          record_id: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "client_launch_checks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_frame_published: {
        Args: {
          p_external_id: string
          p_external_url?: string
          p_position: number
          p_post_id: string
        }
        Returns: undefined
      }
      record_page_revision: {
        Args: {
          p_body?: string
          p_html: string
          p_job_id?: string
          p_meta_description?: string
          p_meta_title?: string
          p_page_id: string
          p_reason?: string
          p_source: string
          p_summary?: string
        }
        Returns: number
      }
      record_post_publish_failure: {
        Args: {
          p_max_attempts?: number
          p_post_id: string
          p_reason: string
          p_retryable?: boolean
        }
        Returns: {
          asset_id: string | null
          channel: Database["public"]["Enums"]["post_channel"]
          client_id: string | null
          created_at: string
          created_by: string | null
          created_by_bot: string | null
          external_id: string | null
          external_url: string | null
          failure_reason: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          notes: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          publication_status: string
          publish_attempts: number
          publish_claimed_at: string | null
          published_at: string | null
          published_by_bot: string | null
          ref_number: string | null
          scheduled_at: string
          scheduled_for: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "scheduled_posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_post_published: {
        Args: {
          p_bot?: string
          p_external_id?: string
          p_external_url?: string
          p_post_id: string
        }
        Returns: {
          asset_id: string | null
          channel: Database["public"]["Enums"]["post_channel"]
          client_id: string | null
          created_at: string
          created_by: string | null
          created_by_bot: string | null
          external_id: string | null
          external_url: string | null
          failure_reason: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          notes: string | null
          platform: Database["public"]["Enums"]["post_platform"] | null
          publication_status: string
          publish_attempts: number
          publish_claimed_at: string | null
          published_at: string | null
          published_by_bot: string | null
          ref_number: string | null
          scheduled_at: string
          scheduled_for: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "scheduled_posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_proof_placed: {
        Args: {
          p_external_id: string
          p_external_url?: string
          p_placement_id: string
        }
        Returns: undefined
      }
      record_proof_placement_failure: {
        Args: {
          p_placement_id: string
          p_reason: string
          p_retryable?: boolean
        }
        Returns: undefined
      }
      record_proof_retracted_v6: {
        Args: { p_detail?: string; p_placement_id: string }
        Returns: undefined
      }
      record_qa_result: {
        Args: {
          p_findings: Json
          p_job_id?: string
          p_note?: string
          p_score: number
          p_slot_id: string
          p_to_stage: Database["public"]["Enums"]["slot_stage"]
        }
        Returns: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "content_slots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_video_render_candidate: {
        Args: {
          p_asset_id: string
          p_attempt: number
          p_job_id: string
          p_media_probe: Json
          p_render_path: string
        }
        Returns: {
          asset_id: string
          attempt: number
          client_id: string
          created_at: string
          creative_review: Json | null
          edit_plan: Json | null
          id: string
          job_id: string
          media_probe: Json
          rejection_reason: string | null
          render_path: string
          reviewed_at: string | null
          verdict: string
        }
        SetofOptions: {
          from: "*"
          to: "video_render_candidates"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_workflow_lead_attribution: {
        Args: {
          p_evidence: Json
          p_label: string
          p_lead_id: string
          p_run_id: string
        }
        Returns: {
          evidence: Json
          label: string
          lead_id: string
          recorded_at: string
          run_id: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_lead_attribution"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      recover_daily_package_item: {
        Args: { p_item_id: string; p_reason: string }
        Returns: {
          id: string
          item_id: string
          reason: string
          reserve_asset_id: string
          selected_at: string
        }
        SetofOptions: {
          from: "*"
          to: "daily_package_recoveries"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      recover_lead: { Args: { p_lead_id: string }; Returns: undefined }
      regenerate_asset: {
        Args: {
          p_asset_id: string
          p_feedback?: string
          p_quality?: string
          p_size?: string
        }
        Returns: string
      }
      regenerate_frame: {
        Args: { p_asset_id: string; p_feedback: string; p_position: number }
        Returns: string
      }
      regenerate_slot: {
        Args: { p_slot_id: string }
        Returns: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "content_slots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reject_slot: {
        Args: { p_reason: string; p_slot_id: string }
        Returns: {
          asset_id: string | null
          attempts: number
          blocked_reason: string | null
          brief_id: string | null
          client_id: string
          cost_usd: number
          created_at: string
          format: Database["public"]["Enums"]["content_format"]
          id: string
          idea_id: string | null
          pillar_id: string | null
          platform: Database["public"]["Enums"]["post_platform"]
          qa_checked_at: string | null
          qa_findings: Json
          qa_score: number | null
          scheduled_at: string
          scheduled_post_id: string | null
          stage: Database["public"]["Enums"]["slot_stage"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "content_slots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_engine_window: {
        Args: { p_window_id: string }
        Returns: undefined
      }
      renew_agent_job_lease: {
        Args: {
          p_job_id: string
          p_lease_owner: string
          p_lease_seconds?: number
        }
        Returns: boolean
      }
      repurpose_asset: {
        Args: { p_asset_id: string; p_formats: string[] }
        Returns: string
      }
      request_campaign_action_approval_v6: {
        Args: {
          p_action_key: string
          p_artifact_version_hash: string
          p_destination: string
          p_idempotency_key: string
          p_manifest_id: string
          p_scope: Json
        }
        Returns: {
          action_key: string
          artifact_version_hash: string
          campaign_id: string
          client_id: string
          decided_at: string | null
          decided_by: string | null
          destination: string
          id: string
          idempotency_key: string
          manifest_id: string
          rejection_reason: string | null
          request_hash: string
          requested_at: string
          scope: Json
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "campaign_action_approvals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_campaign_page_deploy_approval_v6: {
        Args: {
          p_idempotency_key: string
          p_page_id: string
          p_site_path?: string
          p_site_repository_id?: string
        }
        Returns: {
          action_key: string
          artifact_version_hash: string
          campaign_id: string
          client_id: string
          decided_at: string | null
          decided_by: string | null
          destination: string
          id: string
          idempotency_key: string
          manifest_id: string
          rejection_reason: string | null
          request_hash: string
          requested_at: string
          scope: Json
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "campaign_action_approvals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_human_video_edit: {
        Args: { p_asset_id: string; p_due_date?: string; p_member_id: string }
        Returns: string
      }
      request_meta_build: { Args: { p_campaign_id: string }; Returns: string }
      request_meta_build_sheet: {
        Args: { p_campaign_id: string }
        Returns: string
      }
      request_metrics_backfill: {
        Args: {
          p_client_id: string
          p_since: string
          p_surface?: string
          p_until: string
        }
        Returns: string[]
      }
      request_motion_design: {
        Args: {
          p_aspect: string
          p_brand_mode: string
          p_client_id: string
          p_duration_sec: number
          p_preset: string
          p_prompt: string
          p_revision_of?: string
        }
        Returns: string
      }
      request_proof_artifact_v6: {
        Args: {
          p_artifact_kind: string
          p_client_id: string
          p_source_proof_id: string
        }
        Returns: string
      }
      request_proof_auto_production: {
        Args: {
          p_client_id: string
          p_destination: string
          p_direction: string
          p_format: Database["public"]["Enums"]["content_format"]
          p_media_type: Database["public"]["Enums"]["media_type"]
          p_quality?: string
          p_request_id: string
          p_size?: string
          p_source_asset_id: string
          p_source_proof_id: string
        }
        Returns: string
      }
      request_proof_placement_approval_v6: {
        Args: { p_placement_id: string; p_scope?: Json }
        Returns: string
      }
      request_proof_production_v2: {
        Args: {
          p_client_id: string
          p_destination: string
          p_direction: string
          p_format: Database["public"]["Enums"]["content_format"]
          p_media_type: Database["public"]["Enums"]["media_type"]
          p_request_id: string
          p_source_asset_id: string
          p_source_proof_id: string
        }
        Returns: string
      }
      request_recruitment_meta_build: {
        Args: { p_campaign_id: string }
        Returns: string
      }
      request_repurpose_clip: {
        Args: { p_brief_id: string; p_derivative_id: string }
        Returns: string
      }
      request_source_video_edit: {
        Args: {
          p_animated_title: boolean
          p_aspect: string
          p_asset_id: string
          p_brand_treatment: string
          p_captions: boolean
          p_direction: string
          p_feel: string
          p_remove_pauses: boolean
        }
        Returns: string
      }
      request_video_client_approval: {
        Args: { p_asset_id: string; p_client_user_id: string }
        Returns: undefined
      }
      request_video_edit: { Args: { p_asset_id: string }; Returns: string }
      request_video_repurpose_insights: {
        Args: { p_asset_id: string; p_direction?: string }
        Returns: string
      }
      require_opportunity_proof_v6: {
        Args: { p_opportunity_id: string; p_requirement: string }
        Returns: string
      }
      rerender_generation: {
        Args: { p_generation_id: string; p_quality?: string; p_size?: string }
        Returns: string
      }
      resolve_sales_deployment: {
        Args: { p_public_id: string }
        Returns: {
          allowed_origin: string
          booking_rule: string
          client_id: string
          daily_cost_limit_usd: number
          daily_message_limit: number
          deployment_id: string
          escalation_rule: string
          greeting: string
          guardrails: string
          objections: Json
          page_id: string
          qualification: Json
          sales_agent_id: string
          system_prompt: string
          widget_config: Json
        }[]
      }
      resume_completed_daily_motion_qa: {
        Args: { p_run_id: string }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resume_paused_jobs: { Args: never; Returns: number }
      retry_failed_higgsfield_motion_step: {
        Args: { p_failed_requests: Json; p_step_id: string }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_failed_video_creative_workflow_step: {
        Args: { p_step_id: string }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_failed_video_upload_workflow_step: {
        Args: { p_step_id: string }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_missing_render_workflow_step: {
        Args: { p_step_id: string }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_partial_higgsfield_motion_step: {
        Args: { p_step_id: string }
        Returns: {
          agent_key: string
          blocker: string | null
          completed_at: string | null
          created_at: string
          dependencies: string[]
          id: string
          input_from_step_key: string | null
          input_id: string | null
          input_params: Json
          input_table: string
          job_id: string | null
          resolved_input_id: string | null
          run_id: string
          status: string
          step_key: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_steps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_reel_video_build: { Args: { p_brief_id: string }; Returns: string }
      retry_rejected_reel_source: {
        Args: { p_edit_step_id: string; p_feedback: string }
        Returns: {
          created_at: string
          edit_step_id: string
          feedback: string
          id: string
          prior_artifacts: Json
          run_id: string
          source_asset_id: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_reel_source_rebuilds"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revert_page_to_revision: {
        Args: { p_page_id: string; p_revision_number: number }
        Returns: number
      }
      review_media_asset: {
        Args: {
          p_asset_id: string
          p_decision: Database["public"]["Enums"]["review_status"]
          p_reason?: string
        }
        Returns: undefined
      }
      sales_runtime_allow: {
        Args: {
          p_deployment_id: string
          p_ip_hash: string
          p_ip_per_minute?: number
        }
        Returns: {
          allowed: boolean
          reason: string
        }[]
      }
      satisfy_opportunity_proof_v6: {
        Args: { p_proof_id: string; p_requirement_id: string }
        Returns: undefined
      }
      save_campaign_plan_only: {
        Args: {
          p_campaign_id: string
          p_client_id: string
          p_job_id: string
          p_plan: Json
        }
        Returns: undefined
      }
      save_campaign_plan_with_ideas: {
        Args: {
          p_campaign_id: string
          p_client_id: string
          p_ideas: Json
          p_job_id: string
          p_plan: Json
        }
        Returns: number
      }
      save_framed_asset: {
        Args: {
          p_brief_id: string
          p_client_id: string
          p_format: Database["public"]["Enums"]["content_format"]
          p_frames: Json
          p_media_type: Database["public"]["Enums"]["media_type"]
          p_title: string
        }
        Returns: string
      }
      schedule_agent_follow_up: {
        Args: {
          p_after_seconds: number
          p_agent_key: string
          p_client_id: string
          p_current_job_id?: string
          p_description?: string
          p_input_id: string
          p_input_table: string
          p_params?: Json
        }
        Returns: string
      }
      schedule_asset: {
        Args: {
          p_asset_id: string
          p_channel?: Database["public"]["Enums"]["post_channel"]
          p_date: string
          p_platform?: Database["public"]["Enums"]["post_platform"]
          p_time?: string
        }
        Returns: string
      }
      score_market_opportunity_v6: {
        Args: { p_factors: Json; p_note?: string; p_opportunity_id: string }
        Returns: {
          classification: string
          client_id: string
          factors: Json
          id: string
          note: string | null
          opportunity_id: string
          scored_at: string
          scored_by: string | null
          total: number
        }
        SetofOptions: {
          from: "*"
          to: "opportunity_scores"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      score_slot_ideas: {
        Args: { p_slot_id: string }
        Returns: {
          completeness: number
          idea_id: string
          novelty: number
          proof: number
          reasons: Json
          score: number
          title: string
        }[]
      }
      seal_workflow_run: {
        Args: { p_run_id: string }
        Returns: {
          blocker: string | null
          campaign_id: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          deadline_at: string
          id: string
          idempotency_key: string
          input_snapshot: Json
          kind: string
          review_ready_at: string | null
          root_request_id: string | null
          sealed_at: string | null
          status: string
          updated_at: string
          workflow_version: string
        }
        SetofOptions: {
          from: "*"
          to: "workflow_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      select_idea_for_slot: {
        Args: { p_slot_id: string }
        Returns: {
          brief_id: string | null
          client_id: string
          considered: Json
          decided_at: string
          id: string
          idea_id: string | null
          kind: string
          reasons: Json
          score: number | null
          slot_id: string
        }
        SetofOptions: {
          from: "*"
          to: "engine_decisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      select_render: { Args: { p_render_id: string }; Returns: undefined }
      set_brief_sound_treatment: {
        Args: {
          p_brief_id: string
          p_sound_asset_id?: string
          p_treatment: string
        }
        Returns: {
          apply_url: string | null
          archived_at: string | null
          argument: string | null
          avatar_brief: string | null
          b_roll: string | null
          body: string | null
          brief_ref: string | null
          call_to_action: string | null
          channel_intent: string | null
          client_id: string
          compensation_text: string | null
          content_format: Database["public"]["Enums"]["content_format"]
          created_at: string
          derived_from_asset_id: string | null
          editor_brief: string | null
          format_code: string | null
          frame_count: number | null
          frame_plan: string[] | null
          hook: string | null
          id: string
          job_id: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          premise: string | null
          production_method: string | null
          proof: string | null
          proof_asset_id: string | null
          purpose: Database["public"]["Enums"]["content_purpose"]
          recruitment_role:
            | Database["public"]["Enums"]["recruitment_role"]
            | null
          repurpose_format: string | null
          script: string | null
          shot_requirements: string | null
          slot_role: string | null
          sound_asset_id: string | null
          sound_treatment: string
          source_idea_id: string | null
          status: Database["public"]["Enums"]["brief_status"]
          target_platform: Database["public"]["Enums"]["post_platform"] | null
          title: string
          updated_at: string
          visual_direction: string | null
        }
        SetofOptions: {
          from: "*"
          to: "client_briefs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_content_approval_owner: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      set_content_archived_v6: {
        Args: { p_archived?: boolean; p_id: string; p_record: string }
        Returns: undefined
      }
      set_engine_enabled: {
        Args: { p_client_id: string; p_enabled: boolean }
        Returns: {
          approval_mode: string
          auto_approve_briefs: boolean
          auto_approve_ideas: boolean
          client_id: string
          created_at: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          format_mix: Json
          max_jobs_in_flight: number
          min_qa_score: number
          plan_horizon_days: number
          proof_publishing_enabled: boolean
          proof_publishing_enabled_at: string | null
          proof_publishing_enabled_by: string | null
          publishing_enabled: boolean
          publishing_enabled_at: string | null
          publishing_enabled_by: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "client_engine_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_engine_platform: {
        Args: {
          p_active?: boolean
          p_client_id: string
          p_platform: Database["public"]["Enums"]["post_platform"]
          p_posts_per_week: number
        }
        Returns: undefined
      }
      set_engine_running: {
        Args: { p_enabled: boolean; p_note?: string }
        Returns: {
          enabled: boolean
          id: boolean
          note: string | null
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "engine_controls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_engine_settings: {
        Args: {
          p_approval_mode?: string
          p_auto_approve_briefs?: boolean
          p_auto_approve_ideas?: boolean
          p_client_id: string
          p_format_mix?: Json
          p_max_jobs_in_flight?: number
          p_min_qa_score?: number
          p_plan_horizon_days?: number
        }
        Returns: {
          approval_mode: string
          auto_approve_briefs: boolean
          auto_approve_ideas: boolean
          client_id: string
          created_at: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          format_mix: Json
          max_jobs_in_flight: number
          min_qa_score: number
          plan_horizon_days: number
          proof_publishing_enabled: boolean
          proof_publishing_enabled_at: string | null
          proof_publishing_enabled_by: string | null
          publishing_enabled: boolean
          publishing_enabled_at: string | null
          publishing_enabled_by: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "client_engine_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_opportunity_attributes_v6: {
        Args: { p_kind: string; p_opportunity_id: string; p_values: string[] }
        Returns: number
      }
      set_opportunity_awareness_v6: {
        Args: {
          p_asset_direction?: string
          p_distribution_note?: string
          p_message: string
          p_mindset: string
          p_opportunity_id: string
          p_stage: string
        }
        Returns: undefined
      }
      set_opportunity_confidence_v6: {
        Args: {
          p_confidence: Database["public"]["Enums"]["opportunity_confidence"]
          p_note: string
          p_opportunity_id: string
        }
        Returns: undefined
      }
      set_opportunity_fields_v6: {
        Args: {
          p_conversion_action?: string
          p_core_problem?: string
          p_desired_outcome?: string
          p_entry_awareness?: string
          p_opportunity_id: string
          p_positioning?: string
          p_purchase_trigger?: string
        }
        Returns: undefined
      }
      set_opportunity_status_v6: {
        Args: {
          p_note?: string
          p_opportunity_id: string
          p_status: Database["public"]["Enums"]["opportunity_status"]
        }
        Returns: {
          buying_situation: string
          client_id: string
          confidence: Database["public"]["Enums"]["opportunity_confidence"]
          conversion_action: string | null
          core_problem: string | null
          created_at: string
          created_by: string | null
          desired_outcome: string | null
          entry_awareness: string | null
          id: string
          idempotency_key: string
          micro_market: string
          name: string
          positioning: string | null
          proposed_by: string
          proposed_by_job_id: string | null
          purchase_trigger: string | null
          status: Database["public"]["Enums"]["opportunity_status"]
          status_note: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "market_opportunities"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_post_copy: {
        Args: {
          p_alt_text?: string
          p_asset_id?: string
          p_caption?: string
          p_cta?: string
          p_first_comment?: string
          p_hashtags?: string[]
          p_link_url?: string
          p_platform: Database["public"]["Enums"]["post_platform"]
          p_scheduled_post_id?: string
          p_source?: string
        }
        Returns: string
      }
      set_proof_publishing_enabled: {
        Args: { p_client_id: string; p_enabled: boolean }
        Returns: {
          approval_mode: string
          auto_approve_briefs: boolean
          auto_approve_ideas: boolean
          client_id: string
          created_at: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          format_mix: Json
          max_jobs_in_flight: number
          min_qa_score: number
          plan_horizon_days: number
          proof_publishing_enabled: boolean
          proof_publishing_enabled_at: string | null
          proof_publishing_enabled_by: string | null
          publishing_enabled: boolean
          publishing_enabled_at: string | null
          publishing_enabled_by: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "client_engine_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_publishing_enabled: {
        Args: { p_client_id: string; p_enabled: boolean }
        Returns: {
          approval_mode: string
          auto_approve_briefs: boolean
          auto_approve_ideas: boolean
          client_id: string
          created_at: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          format_mix: Json
          max_jobs_in_flight: number
          min_qa_score: number
          plan_horizon_days: number
          proof_publishing_enabled: boolean
          proof_publishing_enabled_at: string | null
          proof_publishing_enabled_by: string | null
          publishing_enabled: boolean
          publishing_enabled_at: string | null
          publishing_enabled_by: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "client_engine_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      settle_completed_blocked_daily_siblings: {
        Args: { p_limit?: number }
        Returns: number
      }
      sign_video_approval: {
        Args: { p_asset_id: string; p_role: string }
        Returns: undefined
      }
      size_fits_format: {
        Args: {
          p_format: Database["public"]["Enums"]["content_format"]
          p_size: string
        }
        Returns: boolean
      }
      slot_has_job_in_flight: { Args: { p_slot_id: string }; Returns: boolean }
      stage_video_candidate_revision: {
        Args: { p_candidate_id: string }
        Returns: Json
      }
      stalled_leads: {
        Args: { p_client_id: string; p_days?: number }
        Returns: {
          days_in_stage: number
          id: string
          name: string
          next_action: string
          next_action_due: string
          opportunity_value: number
          overdue: boolean
          owner_name: string
          stage: Database["public"]["Enums"]["lead_stage"]
        }[]
      }
      start_client_launch_package: {
        Args: {
          p_campaign_id: string
          p_deadline_at: string
          p_idempotency_key: string
        }
        Returns: {
          campaign_id: string
          client_id: string
          created_at: string
          id: string
          input_snapshot: Json
          run_id: string
        }
        SetofOptions: {
          from: "*"
          to: "client_launch_packages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_master_run: { Args: { p_client_id: string }; Returns: string }
      start_master_run_as: {
        Args: { p_actor: string; p_client_id: string }
        Returns: string
      }
      start_onboarding: { Args: { p_client_id: string }; Returns: undefined }
      sweep_expired_proof_placements: { Args: never; Returns: number }
      title_overlap: {
        Args: { p_candidate: string; p_other: string }
        Returns: number
      }
      top_content_by_revenue: {
        Args: { p_client_id: string; p_limit?: number }
        Returns: {
          asset_ref: string
          asset_title: string
          cash_collected: number
          content_territory: string
          hook: string
          idea_title: string
          impressions: number
          leads: number
          sales: number
          spend: number
        }[]
      }
      try_uuid: { Args: { t: string }; Returns: string }
      update_generation_concept: {
        Args: { p_concept: Json; p_generation_id: string }
        Returns: undefined
      }
      update_lead: {
        Args: { p_fields: Json; p_lead_id: string }
        Returns: undefined
      }
      usable_integration_statuses: { Args: never; Returns: string[] }
      usable_proof: {
        Args: { p_avatar?: string; p_client_id: string; p_limit?: number }
        Returns: {
          avatar_relevance: string | null
          body: string | null
          capture_file_mime: string | null
          capture_method: string | null
          captured_on: string | null
          claim: string | null
          client_id: string
          created_at: string
          evidence: string | null
          expires_on: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          permission_basis: string | null
          proof_type: string | null
          ref_number: string | null
          services: string | null
          source: string | null
          source_category: string | null
          source_format: Database["public"]["Enums"]["content_format"]
          source_kind: string | null
          storage_path: string | null
          strength: string
          title: string | null
          updated_at: string
          uploaded_by: string | null
          usage_rights: string
        }[]
        SetofOptions: {
          from: "*"
          to: "client_proof_assets"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      video_approval_state: { Args: { p_asset_id: string }; Returns: Json }
      video_client_approval_email_state: {
        Args: { p_asset_id: string }
        Returns: Json
      }
      weighted_sequence: { Args: { p_weights: Json }; Returns: string[] }
      workflow_run_outcomes: { Args: { p_run_id: string }; Returns: Json }
    }
    Enums: {
      app_role: "admin" | "employee" | "client"
      assignment_stage:
        | "assigned"
        | "accepted"
        | "declined"
        | "delivered"
        | "rework"
        | "approved"
        | "cancelled"
      audience_state: "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6"
      brief_status:
        | "draft"
        | "approved"
        | "rejected"
        | "in_production"
        | "complete"
      build_route: "ai" | "human"
      campaign_status: "active" | "past"
      campaign_template:
        | "P1"
        | "P2"
        | "P3"
        | "P4"
        | "P5"
        | "R1"
        | "R2"
        | "R3"
        | "R4"
        | "C1"
        | "C2"
        | "C3"
        | "O1"
        | "O2"
        | "X1"
        | "X2"
      content_format: "single" | "carousel" | "story" | "reel"
      content_purpose: "client" | "recruitment"
      creative_stage: "concept" | "render" | "motion" | "done" | "failed"
      engagement_type: "employee" | "contractor"
      idea_source: "manual" | "auto" | "proof" | "pillar"
      idea_status: "draft" | "approved" | "rejected" | "briefed"
      job_status:
        | "queued"
        | "paused"
        | "claimed"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
      lead_stage:
        | "lead"
        | "conversation"
        | "qualified_conversation"
        | "appointment"
        | "qualified_appointment"
        | "shown"
        | "sale"
        | "cash"
        | "lost"
        | "profile_visit"
        | "follower"
        | "qualified"
      master_ai_scope: "client" | "company"
      media_type: "image" | "text" | "video"
      metric_basis: "daily" | "cumulative"
      metric_entity: "account" | "campaign" | "post" | "page"
      metric_surface: "paid" | "organic" | "landing" | "offer"
      opportunity_confidence:
        | "hypothesis"
        | "desk_research"
        | "conversation"
        | "first_party"
        | "proven"
      opportunity_status:
        | "discovered"
        | "validated"
        | "approved"
        | "active"
        | "learning"
        | "scaling"
        | "paused"
        | "rejected"
      page_type: "landing" | "offer" | "recruitment"
      pipeline_stage: "first_touch" | "second_touch" | "call_booked"
      post_channel: "organic" | "paid"
      post_platform:
        | "facebook"
        | "instagram"
        | "tiktok"
        | "linkedin"
        | "youtube"
      record_domain:
        | "icp"
        | "competitor"
        | "association"
        | "market"
        | "proof"
        | "campaign_intel"
        | "brand_strategy"
        | "offer_strategy"
        | "money_model"
        | "reporting"
      record_status: "draft" | "approved" | "superseded"
      recruitment_role: "editor" | "smm" | "avatar"
      render_status: "queued" | "rendering" | "done" | "failed"
      review_status: "pending" | "approved" | "rejected"
      slot_stage:
        | "planned"
        | "ideating"
        | "idea_selected"
        | "briefing"
        | "building"
        | "editing"
        | "copywriting"
        | "qa"
        | "awaiting_approval"
        | "scheduled"
        | "published"
        | "failed"
        | "rejected"
      step_status: "pending" | "in_progress" | "complete"
      team_category: "avatars" | "editors" | "smm"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["admin", "employee", "client"],
      assignment_stage: [
        "assigned",
        "accepted",
        "declined",
        "delivered",
        "rework",
        "approved",
        "cancelled",
      ],
      audience_state: ["S0", "S1", "S2", "S3", "S4", "S5", "S6"],
      brief_status: [
        "draft",
        "approved",
        "rejected",
        "in_production",
        "complete",
      ],
      build_route: ["ai", "human"],
      campaign_status: ["active", "past"],
      campaign_template: [
        "P1",
        "P2",
        "P3",
        "P4",
        "P5",
        "R1",
        "R2",
        "R3",
        "R4",
        "C1",
        "C2",
        "C3",
        "O1",
        "O2",
        "X1",
        "X2",
      ],
      content_format: ["single", "carousel", "story", "reel"],
      content_purpose: ["client", "recruitment"],
      creative_stage: ["concept", "render", "motion", "done", "failed"],
      engagement_type: ["employee", "contractor"],
      idea_source: ["manual", "auto", "proof", "pillar"],
      idea_status: ["draft", "approved", "rejected", "briefed"],
      job_status: [
        "queued",
        "paused",
        "claimed",
        "running",
        "completed",
        "failed",
        "cancelled",
      ],
      lead_stage: [
        "lead",
        "conversation",
        "qualified_conversation",
        "appointment",
        "qualified_appointment",
        "shown",
        "sale",
        "cash",
        "lost",
        "profile_visit",
        "follower",
        "qualified",
      ],
      master_ai_scope: ["client", "company"],
      media_type: ["image", "text", "video"],
      metric_basis: ["daily", "cumulative"],
      metric_entity: ["account", "campaign", "post", "page"],
      metric_surface: ["paid", "organic", "landing", "offer"],
      opportunity_confidence: [
        "hypothesis",
        "desk_research",
        "conversation",
        "first_party",
        "proven",
      ],
      opportunity_status: [
        "discovered",
        "validated",
        "approved",
        "active",
        "learning",
        "scaling",
        "paused",
        "rejected",
      ],
      page_type: ["landing", "offer", "recruitment"],
      pipeline_stage: ["first_touch", "second_touch", "call_booked"],
      post_channel: ["organic", "paid"],
      post_platform: ["facebook", "instagram", "tiktok", "linkedin", "youtube"],
      record_domain: [
        "icp",
        "competitor",
        "association",
        "market",
        "proof",
        "campaign_intel",
        "brand_strategy",
        "offer_strategy",
        "money_model",
        "reporting",
      ],
      record_status: ["draft", "approved", "superseded"],
      recruitment_role: ["editor", "smm", "avatar"],
      render_status: ["queued", "rendering", "done", "failed"],
      review_status: ["pending", "approved", "rejected"],
      slot_stage: [
        "planned",
        "ideating",
        "idea_selected",
        "briefing",
        "building",
        "editing",
        "copywriting",
        "qa",
        "awaiting_approval",
        "scheduled",
        "published",
        "failed",
        "rejected",
      ],
      step_status: ["pending", "in_progress", "complete"],
      team_category: ["avatars", "editors", "smm"],
    },
  },
} as const
