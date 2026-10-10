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
    PostgrestVersion: "14.5"
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
          target_platform: Database["public"]["Enums"]["post_platform"] | null
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
          source_idea_id: string | null
          status: Database["public"]["Enums"]["brief_status"]
          title: string
          updated_at: string
          visual_direction: string | null
        }
        Insert: {
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
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
          source_idea_id?: string | null
          status?: Database["public"]["Enums"]["brief_status"]
          title: string
          updated_at?: string
          visual_direction?: string | null
        }
        Update: {
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
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
          source_idea_id?: string | null
          status?: Database["public"]["Enums"]["brief_status"]
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
          ad_campaign_id: string | null
          archived_at: string | null
          audience: string | null
          brief: string
          budget: number | null
          built_at: string | null
          channels: string[]
          client_id: string
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
          optimisation_event: string | null
          starts_on: string | null
          status: string
          target_countries: string[]
          template: Database["public"]["Enums"]["campaign_template"] | null
          updated_at: string
        }
        Insert: {
          ad_campaign_id?: string | null
          archived_at?: string | null
          audience?: string | null
          brief: string
          budget?: number | null
          built_at?: string | null
          channels?: string[]
          client_id: string
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
          optimisation_event?: string | null
          starts_on?: string | null
          status?: string
          target_countries?: string[]
          template?: Database["public"]["Enums"]["campaign_template"] | null
          updated_at?: string
        }
        Update: {
          ad_campaign_id?: string | null
          archived_at?: string | null
          audience?: string | null
          brief?: string
          budget?: number | null
          built_at?: string | null
          channels?: string[]
          client_id?: string
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
          optimisation_event?: string | null
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
          target_platform: Database["public"]["Enums"]["post_platform"] | null
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
          title: string
          updated_at: string
        }
        Insert: {
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
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
          title: string
          updated_at?: string
        }
        Update: {
          target_platform?: Database["public"]["Enums"]["post_platform"] | null
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
          captured_on: string | null
          claim: string | null
          client_id: string
          created_at: string
          evidence: string | null
          expires_on: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          proof_type: string | null
          ref_number: string | null
          services: string | null
          source: string | null
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
          captured_on?: string | null
          claim?: string | null
          client_id: string
          created_at?: string
          evidence?: string | null
          expires_on?: string | null
          id?: string
          media_type: Database["public"]["Enums"]["media_type"]
          proof_type?: string | null
          ref_number?: string | null
          services?: string | null
          source?: string | null
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
          captured_on?: string | null
          claim?: string | null
          client_id?: string
          created_at?: string
          evidence?: string | null
          expires_on?: string | null
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          proof_type?: string | null
          ref_number?: string | null
          services?: string | null
          source?: string | null
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
          stage: Database["public"]["Enums"]["assignment_stage"]
          stage_reason: string | null
          source_asset_id: string | null
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
          stage?: Database["public"]["Enums"]["assignment_stage"]
          stage_reason?: string | null
          source_asset_id?: string | null
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
          stage?: Database["public"]["Enums"]["assignment_stage"]
          stage_reason?: string | null
          source_asset_id?: string | null
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
      publish_due: {
        Row: {
          alt_text: string | null
          asset_id: string | null
          asset_title: string | null
          blocker: string | null
          caption: string | null
          client_id: string | null
          client_name: string | null
          first_comment: string | null
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
      motion_design_projects: {
        Row: {
          id: string
          client_id: string
          prompt: string
          preset: string
          aspect: string
          duration_sec: number
          brand_mode: string
          revision_of: string | null
          status: string
          scene_plan: Json | null
          render_path: string | null
          poster_path: string | null
          job_id: string | null
          error: string | null
          created_by: string | null
          created_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          client_id: string
          prompt: string
          preset: string
          aspect: string
          duration_sec: number
          brand_mode: string
          revision_of?: string | null
          status?: string
          scene_plan?: Json | null
          render_path?: string | null
          poster_path?: string | null
          job_id?: string | null
          error?: string | null
          created_by?: string | null
          created_at?: string
          completed_at?: string | null
        }
        Update: {
          id?: string
          client_id?: string
          prompt?: string
          preset?: string
          aspect?: string
          duration_sec?: number
          brand_mode?: string
          revision_of?: string | null
          status?: string
          scene_plan?: Json | null
          render_path?: string | null
          poster_path?: string | null
          job_id?: string | null
          error?: string | null
          created_by?: string | null
          created_at?: string
          completed_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "motion_design_projects_client_id_fkey"; columns: ["client_id"]; isOneToOne: false; referencedRelation: "clients"; referencedColumns: ["id"] },
          { foreignKeyName: "motion_design_projects_revision_of_fkey"; columns: ["revision_of"]; isOneToOne: false; referencedRelation: "motion_design_projects"; referencedColumns: ["id"] },
          { foreignKeyName: "motion_design_projects_job_id_fkey"; columns: ["job_id"]; isOneToOne: false; referencedRelation: "agent_jobs"; referencedColumns: ["id"] },
        ]
      }
      video_source_edit_requests: {
        Row: {
          id: string
          client_id: string
          source_asset_id: string
          output_asset_id: string | null
          job_id: string | null
          direction: string
          aspect: string
          remove_pauses: boolean
          captions: boolean
          animated_title: boolean
          brand_treatment: string
          feel: string
          status: string
          error: string | null
          transcript: Json | null
          edit_plan: Json | null
          created_by: string | null
          created_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          client_id: string
          source_asset_id: string
          output_asset_id?: string | null
          job_id?: string | null
          direction: string
          aspect: string
          remove_pauses?: boolean
          captions?: boolean
          animated_title?: boolean
          brand_treatment: string
          feel: string
          status?: string
          error?: string | null
          transcript?: Json | null
          edit_plan?: Json | null
          created_by?: string | null
          created_at?: string
          completed_at?: string | null
        }
        Update: {
          id?: string
          client_id?: string
          source_asset_id?: string
          output_asset_id?: string | null
          job_id?: string | null
          direction?: string
          aspect?: string
          remove_pauses?: boolean
          captions?: boolean
          animated_title?: boolean
          brand_treatment?: string
          feel?: string
          status?: string
          error?: string | null
          transcript?: Json | null
          edit_plan?: Json | null
          created_by?: string | null
          created_at?: string
          completed_at?: string | null
        }
        Relationships: [
          { foreignKeyName: "video_source_edit_requests_client_id_fkey"; columns: ["client_id"]; isOneToOne: false; referencedRelation: "clients"; referencedColumns: ["id"] },
          { foreignKeyName: "video_source_edit_requests_source_asset_id_fkey"; columns: ["source_asset_id"]; isOneToOne: false; referencedRelation: "client_media_assets"; referencedColumns: ["id"] },
          { foreignKeyName: "video_source_edit_requests_output_asset_id_fkey"; columns: ["output_asset_id"]; isOneToOne: false; referencedRelation: "client_media_assets"; referencedColumns: ["id"] },
          { foreignKeyName: "video_source_edit_requests_job_id_fkey"; columns: ["job_id"]; isOneToOne: false; referencedRelation: "agent_jobs"; referencedColumns: ["id"] },
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
      request_motion_design: {
        Args: {
          p_client_id: string
          p_prompt: string
          p_preset: string
          p_aspect: string
          p_duration_sec: number
          p_brand_mode: string
          p_revision_of?: string | null
        }
        Returns: string
      }
      request_source_video_edit: {
        Args: {
          p_asset_id: string
          p_direction: string
          p_aspect: string
          p_remove_pauses: boolean
          p_captions: boolean
          p_animated_title: boolean
          p_brand_treatment: string
          p_feel: string
        }
        Returns: string
      }
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
      approve_recruitment_brief: {
        Args: { p_brief_id: string }
        Returns: undefined
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
      claim_posts_for_publishing: {
        Args: { p_limit?: number }
        Returns: {
          alt_text: string
          asset_id: string
          attempt: number
          caption: string
          client_id: string
          first_comment: string
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
      current_member_id: { Args: never; Returns: string }
      current_role_of: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
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
      enqueue_format_ideation: {
        Args: {
          p_client_id: string
          p_target_platform: Database["public"]["Enums"]["post_platform"]
          p_media_type: Database["public"]["Enums"]["media_type"]
          p_content_format: Database["public"]["Enums"]["content_format"]
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
      enqueue_token_health_job: { Args: never; Returns: string }
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
      integration_secret: {
        Args: { p_client_id: string; p_provider: string }
        Returns: string
      }
      integration_usable: {
        Args: { p_client_id: string; p_provider: string }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
      is_channel_member: { Args: { target: string }; Returns: boolean }
      is_client_user: { Args: { target: string }; Returns: boolean }
      is_member: { Args: { target: string }; Returns: boolean }
      launch_campaign: { Args: { p_campaign_id: string }; Returns: undefined }
      lead_stage_rank: {
        Args: { s: Database["public"]["Enums"]["lead_stage"] }
        Returns: number
      }
      lock_down_definer_functions: { Args: never; Returns: number }
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
      request_recruitment_meta_build: {
        Args: { p_campaign_id: string }
        Returns: string
      }
      request_video_edit: { Args: { p_asset_id: string }; Returns: string }
      intake_video_for_edit: {
        Args: { p_asset_id: string; p_client_id: string; p_title: string; p_storage_path: string
          p_format: Database["public"]["Enums"]["content_format"]; p_source: string; p_rights: string
          p_brief_id?: string; p_notes?: string }
        Returns: Json
      }
      accept_video_as_finished: { Args: { p_asset_id: string }; Returns: undefined }
      set_content_approval_owner: { Args: { p_user_id: string }; Returns: undefined }
      video_approval_state: { Args: { p_asset_id: string }; Returns: Json }
      sign_video_approval: { Args: { p_asset_id: string; p_role: string }; Returns: undefined }
      request_video_client_approval: {
        Args: { p_asset_id: string; p_client_user_id: string }
        Returns: undefined
      }
      decline_video_client_approval: {
        Args: { p_asset_id: string; p_reason: string }
        Returns: undefined
      }
      video_client_approval_email_state: { Args: { p_asset_id: string }; Returns: Json }
      request_human_video_edit: {
        Args: { p_asset_id: string; p_member_id: string; p_due_date?: string }
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
      resume_paused_jobs: { Args: never; Returns: number }
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
      size_fits_format: {
        Args: {
          p_format: Database["public"]["Enums"]["content_format"]
          p_size: string
        }
        Returns: boolean
      }
      slot_has_job_in_flight: { Args: { p_slot_id: string }; Returns: boolean }
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
      start_master_run: { Args: { p_client_id: string }; Returns: string }
      start_master_run_as: {
        Args: { p_actor: string; p_client_id: string }
        Returns: string
      }
      start_onboarding: { Args: { p_client_id: string }; Returns: undefined }
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
          captured_on: string | null
          claim: string | null
          client_id: string
          created_at: string
          evidence: string | null
          expires_on: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          proof_type: string | null
          ref_number: string | null
          services: string | null
          source: string | null
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
      weighted_sequence: { Args: { p_weights: Json }; Returns: string[] }
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
