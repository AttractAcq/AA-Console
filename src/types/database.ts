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
          run_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
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
          run_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
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
          run_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
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
      agent_tool_calls: {
        Row: {
          client_id: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          input_summary: string | null
          job_id: string
          output_summary: string | null
          permission_class: string
          started_at: string | null
          status: string
          tool_name: string
        }
        Insert: {
          client_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          input_summary?: string | null
          job_id: string
          output_summary?: string | null
          permission_class?: string
          started_at?: string | null
          status?: string
          tool_name: string
        }
        Update: {
          client_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          input_summary?: string | null
          job_id?: string
          output_summary?: string | null
          permission_class?: string
          started_at?: string | null
          status?: string
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tool_calls_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tool_calls_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
        ]
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
          requires_upstream: string[]
          requires_input: boolean
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
          requires_upstream?: string[]
          requires_input?: boolean
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
          requires_upstream?: string[]
          requires_input?: boolean
          scheduled_only?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      brief_dispatches: {
        Row: {
          assignment_id: string | null
          brief_id: string
          client_id: string
          created_at: string
          email_error: string | null
          email_status: string
          emailed_at: string | null
          id: string
          job_id: string | null
          member_id: string
          sent_by: string | null
        }
        Insert: {
          assignment_id?: string | null
          brief_id: string
          client_id: string
          created_at?: string
          email_error?: string | null
          email_status?: string
          emailed_at?: string | null
          id?: string
          job_id?: string | null
          member_id: string
          sent_by?: string | null
        }
        Update: {
          assignment_id?: string | null
          brief_id?: string
          client_id?: string
          created_at?: string
          email_error?: string | null
          email_status?: string
          emailed_at?: string | null
          id?: string
          job_id?: string | null
          member_id?: string
          sent_by?: string | null
        }
        Relationships: [
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
            foreignKeyName: "brief_dispatches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brief_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
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
        }
        Insert: {
          asset_id: string
          created_at?: string
          decision: Database["public"]["Enums"]["review_status"]
          id?: string
          reason?: string | null
          reviewed_by?: string | null
        }
        Update: {
          asset_id?: string
          created_at?: string
          decision?: Database["public"]["Enums"]["review_status"]
          id?: string
          reason?: string | null
          reviewed_by?: string | null
        }
        Relationships: [
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
        ]
      }
      client_briefs: {
        Row: {
          argument: string | null
          b_roll: string | null
          body: string | null
          brief_ref: string | null
          derived_from_asset_id: string | null
          repurpose_format: string | null
          call_to_action: string | null
          channel_intent: string | null
          client_id: string
          created_at: string
          hook: string | null
          id: string
          job_id: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          premise: string | null
          production_method: string | null
          proof: string | null
          proof_asset_id: string | null
          script: string | null
          shot_requirements: string | null
          source_idea_id: string | null
          status: Database["public"]["Enums"]["brief_status"]
          title: string
          updated_at: string
          visual_direction: string | null
        }
        Insert: {
          argument?: string | null
          b_roll?: string | null
          body?: string | null
          brief_ref?: string | null
          derived_from_asset_id?: string | null
          repurpose_format?: string | null
          call_to_action?: string | null
          channel_intent?: string | null
          client_id: string
          created_at?: string
          hook?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          premise?: string | null
          production_method?: string | null
          proof?: string | null
          proof_asset_id?: string | null
          script?: string | null
          shot_requirements?: string | null
          source_idea_id?: string | null
          status?: Database["public"]["Enums"]["brief_status"]
          title: string
          updated_at?: string
          visual_direction?: string | null
        }
        Update: {
          argument?: string | null
          b_roll?: string | null
          body?: string | null
          brief_ref?: string | null
          derived_from_asset_id?: string | null
          repurpose_format?: string | null
          call_to_action?: string | null
          channel_intent?: string | null
          client_id?: string
          created_at?: string
          hook?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          premise?: string | null
          production_method?: string | null
          proof?: string | null
          proof_asset_id?: string | null
          script?: string | null
          shot_requirements?: string | null
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
            foreignKeyName: "client_briefs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
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
            foreignKeyName: "client_briefs_source_idea_id_fkey"
            columns: ["source_idea_id"]
            isOneToOne: false
            referencedRelation: "client_ideas"
            referencedColumns: ["id"]
          },
        ]
      }
      client_business_context: {
        Row: {
          brand_voice: string | null
          business_overview: string | null
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
            foreignKeyName: "client_business_context_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
            foreignKeyName: "client_contracts_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_ideas: {
        Row: {
          body: string | null
          client_id: string
          content_territory: string | null
          created_at: string
          created_by: string | null
          id: string
          job_id: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          proof_id: string | null
          source: Database["public"]["Enums"]["idea_source"]
          source_question: string | null
          status: Database["public"]["Enums"]["idea_status"]
          strategic_reason: string | null
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          client_id: string
          content_territory?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          proof_id?: string | null
          source: Database["public"]["Enums"]["idea_source"]
          source_question?: string | null
          status?: Database["public"]["Enums"]["idea_status"]
          strategic_reason?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          client_id?: string
          content_territory?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          proof_id?: string | null
          source?: Database["public"]["Enums"]["idea_source"]
          source_question?: string | null
          status?: Database["public"]["Enums"]["idea_status"]
          strategic_reason?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_ideas_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
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
            foreignKeyName: "client_ideas_proof_id_fkey"
            columns: ["proof_id"]
            isOneToOne: false
            referencedRelation: "client_proof_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      client_integrations: {
        Row: {
          access_level: string | null
          client_id: string
          created_at: string
          credential_label: string | null
          credential_secret_id: string | null
          id: string
          ingest_enabled: boolean
          last_checked_at: string | null
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          access_level?: string | null
          client_id: string
          created_at?: string
          credential_label?: string | null
          credential_secret_id?: string | null
          id?: string
          ingest_enabled?: boolean
          last_checked_at?: string | null
          provider: string
          status?: string
          updated_at?: string
        }
        Update: {
          access_level?: string | null
          client_id?: string
          created_at?: string
          credential_label?: string | null
          credential_secret_id?: string | null
          id?: string
          ingest_enabled?: boolean
          last_checked_at?: string | null
          provider?: string
          status?: string
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
        ]
      }
      client_leads: {
        Row: {
          client_id: string
          contact: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string | null
          notes: string | null
          email: string | null
          phone: string | null
          stage: Database["public"]["Enums"]["lead_stage"]
          stage_at: string
          lost_reason: string | null
          owner_member_id: string | null
          next_action: string | null
          next_action_due: string | null
          opportunity_value: number | null
          sale_value: number | null
          cash_collected: number | null
          appointment_at: string | null
          appointment_outcome: string | null
          source_channel: string | null
          source_page_id: string | null
          source_sales_agent_id: string | null
          source_asset_id: string | null
          source_post_id: string | null
          source_campaign_id: string | null
          pipeline_stage: Database["public"]["Enums"]["pipeline_stage"]
          source: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          contact?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          email?: string | null
          phone?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"]
          stage_at?: string
          lost_reason?: string | null
          owner_member_id?: string | null
          next_action?: string | null
          next_action_due?: string | null
          opportunity_value?: number | null
          sale_value?: number | null
          cash_collected?: number | null
          appointment_at?: string | null
          appointment_outcome?: string | null
          source_channel?: string | null
          source_page_id?: string | null
          source_sales_agent_id?: string | null
          source_asset_id?: string | null
          source_post_id?: string | null
          source_campaign_id?: string | null
          pipeline_stage?: Database["public"]["Enums"]["pipeline_stage"]
          source?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          contact?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          email?: string | null
          phone?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"]
          stage_at?: string
          lost_reason?: string | null
          owner_member_id?: string | null
          next_action?: string | null
          next_action_due?: string | null
          opportunity_value?: number | null
          sale_value?: number | null
          cash_collected?: number | null
          appointment_at?: string | null
          appointment_outcome?: string | null
          source_channel?: string | null
          source_page_id?: string | null
          source_sales_agent_id?: string | null
          source_asset_id?: string | null
          source_post_id?: string | null
          source_campaign_id?: string | null
          pipeline_stage?: Database["public"]["Enums"]["pipeline_stage"]
          source?: string | null
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
            foreignKeyName: "client_leads_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_media_assets: {
        Row: {
          brief_id: string | null
          client_id: string
          created_at: string
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          member_id: string | null
          ref_number: string | null
          review_status: Database["public"]["Enums"]["review_status"]
          storage_path: string
          title: string | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          brief_id?: string | null
          client_id: string
          created_at?: string
          id?: string
          media_type: Database["public"]["Enums"]["media_type"]
          member_id?: string | null
          ref_number?: string | null
          review_status?: Database["public"]["Enums"]["review_status"]
          storage_path: string
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          brief_id?: string | null
          client_id?: string
          created_at?: string
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          member_id?: string | null
          ref_number?: string | null
          review_status?: Database["public"]["Enums"]["review_status"]
          storage_path?: string
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
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
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
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
            foreignKeyName: "client_onboarding_steps_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_sales_agents: {
        Row: {
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
          status: string
          system_prompt: string | null
          updated_at: string
        }
        Insert: {
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
          status?: string
          system_prompt?: string | null
          updated_at?: string
        }
        Update: {
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
          status?: string
          system_prompt?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      sales_agent_conversations: {
        Row: {
          client_id: string
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
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
        Relationships: []
      }
      client_campaigns: {
        Row: {
          ad_campaign_id: string | null
          audience: string | null
          brief: string
          budget: number | null
          built_at: string | null
          channels: string[]
          client_id: string
          content_count: number
          core_message: string | null
          created_at: string
          ends_on: string | null
          id: string
          job_id: string | null
          kpi_metric: string | null
          kpi_target: number | null
          launched_at: string | null
          name: string
          needs_landing_page: boolean
          needs_sales_agent: boolean
          objective: string | null
          offer_summary: string | null
          starts_on: string | null
          status: string
          updated_at: string
        }
        Insert: {
          ad_campaign_id?: string | null
          audience?: string | null
          brief: string
          budget?: number | null
          built_at?: string | null
          channels?: string[]
          client_id: string
          content_count?: number
          core_message?: string | null
          created_at?: string
          ends_on?: string | null
          id?: string
          job_id?: string | null
          kpi_metric?: string | null
          kpi_target?: number | null
          launched_at?: string | null
          name: string
          needs_landing_page?: boolean
          needs_sales_agent?: boolean
          objective?: string | null
          offer_summary?: string | null
          starts_on?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          ad_campaign_id?: string | null
          audience?: string | null
          brief?: string
          budget?: number | null
          built_at?: string | null
          channels?: string[]
          client_id?: string
          content_count?: number
          core_message?: string | null
          created_at?: string
          ends_on?: string | null
          id?: string
          job_id?: string | null
          kpi_metric?: string | null
          kpi_target?: number | null
          launched_at?: string | null
          name?: string
          needs_landing_page?: boolean
          needs_sales_agent?: boolean
          objective?: string | null
          offer_summary?: string | null
          starts_on?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
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
        Relationships: []
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
        Relationships: []
      }
      client_pages: {
        Row: {
          body: string | null
          brief: string | null
          client_id: string
          created_at: string
          created_by: string | null
          id: string
          job_id: string | null
          page_type: Database["public"]["Enums"]["page_type"]
          published_url: string | null
          html: string | null
          meta_title: string | null
          meta_description: string | null
          built_at: string | null
          status: Database["public"]["Enums"]["record_status"]
          thumbnail_path: string | null
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          brief?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          page_type: Database["public"]["Enums"]["page_type"]
          published_url?: string | null
          html?: string | null
          meta_title?: string | null
          meta_description?: string | null
          built_at?: string | null
          status?: Database["public"]["Enums"]["record_status"]
          thumbnail_path?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          brief?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          page_type?: Database["public"]["Enums"]["page_type"]
          published_url?: string | null
          html?: string | null
          meta_title?: string | null
          meta_description?: string | null
          built_at?: string | null
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
        ]
      }
      client_proof_assets: {
        Row: {
          body: string | null
          client_id: string
          created_at: string
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          source: string | null
          storage_path: string | null
          ref_number: string | null
          proof_type: string | null
          claim: string | null
          evidence: string | null
          avatar_relevance: string | null
          services: string | null
          strength: string
          usage_rights: string
          captured_on: string | null
          expires_on: string | null
          updated_at: string
          title: string | null
          uploaded_by: string | null
        }
        Insert: {
          body?: string | null
          client_id: string
          created_at?: string
          id?: string
          media_type: Database["public"]["Enums"]["media_type"]
          source?: string | null
          storage_path?: string | null
          ref_number?: string | null
          proof_type?: string | null
          claim?: string | null
          evidence?: string | null
          avatar_relevance?: string | null
          services?: string | null
          strength?: string
          usage_rights?: string
          captured_on?: string | null
          expires_on?: string | null
          updated_at?: string
          title?: string | null
          uploaded_by?: string | null
        }
        Update: {
          body?: string | null
          client_id?: string
          created_at?: string
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          source?: string | null
          storage_path?: string | null
          ref_number?: string | null
          proof_type?: string | null
          claim?: string | null
          evidence?: string | null
          avatar_relevance?: string | null
          services?: string | null
          strength?: string
          usage_rights?: string
          captured_on?: string | null
          expires_on?: string | null
          updated_at?: string
          title?: string | null
          uploaded_by?: string | null
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
            foreignKeyName: "client_proof_assets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
          updated_at?: string
        }
        Relationships: []
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
          size?: string
          stage?: Database["public"]["Enums"]["creative_stage"]
          updated_at?: string
        }
        Relationships: [
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
            foreignKeyName: "creative_generations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_generations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
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
        ]
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
      job_assignments: {
        Row: {
          brief_id: string | null
          client_id: string | null
          compensation: number | null
          completed_at: string | null
          created_at: string
          due_date: string | null
          id: string
          member_id: string
          title: string
          updated_at: string
        }
        Insert: {
          brief_id?: string | null
          client_id?: string | null
          compensation?: number | null
          completed_at?: string | null
          created_at?: string
          due_date?: string | null
          id?: string
          member_id: string
          title: string
          updated_at?: string
        }
        Update: {
          brief_id?: string | null
          client_id?: string | null
          compensation?: number | null
          completed_at?: string | null
          created_at?: string
          due_date?: string | null
          id?: string
          member_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_assignments_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "client_briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
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
            foreignKeyName: "metrics_daily_post_id_fkey"
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
        ]
      }
      scheduled_posts: {
        Row: {
          asset_id: string | null
          channel: Database["public"]["Enums"]["post_channel"]
          client_id: string | null
          created_at: string
          created_by: string | null
          external_id: string | null
          id: string
          media_type: Database["public"]["Enums"]["media_type"]
          notes: string | null
          published_at: string | null
          ref_number: string | null
          scheduled_for: string
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          channel?: Database["public"]["Enums"]["post_channel"]
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          external_id?: string | null
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          notes?: string | null
          published_at?: string | null
          ref_number?: string | null
          scheduled_for: string
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          channel?: Database["public"]["Enums"]["post_channel"]
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          external_id?: string | null
          id?: string
          media_type?: Database["public"]["Enums"]["media_type"]
          notes?: string | null
          published_at?: string | null
          ref_number?: string | null
          scheduled_for?: string
          updated_at?: string
        }
        Relationships: [
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
            foreignKeyName: "scheduled_posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
          category: Database["public"]["Enums"]["team_category"]
          contact_info: string | null
          created_at: string
          engagement: Database["public"]["Enums"]["engagement_type"]
          id: string
          initials: string
          name: string
          personal_info: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          category: Database["public"]["Enums"]["team_category"]
          contact_info?: string | null
          created_at?: string
          engagement?: Database["public"]["Enums"]["engagement_type"]
          id?: string
          initials: string
          name: string
          personal_info?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          category?: Database["public"]["Enums"]["team_category"]
          contact_info?: string | null
          created_at?: string
          engagement?: Database["public"]["Enums"]["engagement_type"]
          id?: string
          initials?: string
          name?: string
          personal_info?: string | null
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
      approvals_queue: {
        Row: {
          brief_id: string | null
          brief_title: string | null
          client_id: string | null
          client_name: string | null
          created_at: string | null
          id: string | null
          media_type: Database["public"]["Enums"]["media_type"] | null
          member_id: string | null
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
            foreignKeyName: "client_media_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
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
      campaign_totals: {
        Row: {
          active_campaigns: number | null
          current_daily_spend: number | null
          lifetime_spend: number | null
        }
        Relationships: []
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
        ]
      }
      mrr_from_billing: {
        Row: {
          mrr: number | null
          paying_clients: number | null
        }
        Relationships: []
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
      accessible_client_ids: { Args: never; Returns: string[] }
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
      approve_idea_and_generate_brief: {
        Args: { p_idea_id: string }
        Returns: string
      }
      build_brief_with_ai: {
        Args: {
          p_brief_id: string
          p_quality?: string
          p_reference_path?: string
          p_size?: string
        }
        Returns: string
      }
      can_access_client: { Args: { target: string }; Returns: boolean }
      can_run_agent: {
        Args: { p_agent_key: string; p_client_id: string }
        Returns: boolean
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
          run_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
        }
        SetofOptions: {
          from: "*"
          to: "agent_jobs"
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
      current_member_id: { Args: never; Returns: string }
      current_role_of: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      dispatch_brief_to_members: {
        Args: {
          p_brief_id: string
          p_compensation?: number
          p_due_date?: string
          p_member_ids: string[]
        }
        Returns: number
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
      enqueue_metrics_ingest_jobs: {
        Args: { p_days?: number }
        Returns: number
      }
      integration_secret: {
        Args: { p_client_id: string; p_provider: string }
        Returns: string
      }
      is_admin: { Args: never; Returns: boolean }
      is_channel_member: { Args: { target: string }; Returns: boolean }
      is_client_user: { Args: { target: string }; Returns: boolean }
      is_member: { Args: { target: string }; Returns: boolean }
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
      renew_agent_job_lease: {
        Args: {
          p_job_id: string
          p_lease_owner: string
          p_lease_seconds?: number
        }
        Returns: boolean
      }
      rerender_generation: {
        Args: { p_generation_id: string; p_quality?: string; p_size?: string }
        Returns: string
      }
      repurpose_asset: {
        Args: { p_asset_id: string; p_formats: string[] }
        Returns: string
      }
      usable_proof: {
        Args: { p_client_id: string; p_avatar?: string; p_limit?: number }
        Returns: Database["public"]["Tables"]["client_proof_assets"]["Row"][]
      }
      campaign_readiness: {
        Args: { p_campaign_id: string }
        Returns: {
          requirement: string
          required: number
          have: number
          met: boolean
          detail: string
        }[]
      }
      provision_campaign: {
        Args: { p_campaign_id: string }
        Returns: {
          created: string
          artifact_id: string
        }[]
      }
      launch_campaign: {
        Args: { p_campaign_id: string }
        Returns: undefined
      }
      client_economics: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: {
          spend: number
          leads: number
          qualified_leads: number
          appointments: number
          customers: number
          revenue: number
          cash_collected: number
          cpl: number | null
          cpql: number | null
          cpa: number | null
          cac: number | null
          roas: number | null
          cash_roas: number | null
          revenue_per_lead: number | null
          avg_customer_value: number | null
          currency: string | null
          mixed_currency: boolean
        }[]
      }
      client_economics_by_channel: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: {
          channel: string
          spend: number
          leads: number
          customers: number
          revenue: number
          cash_collected: number
          cpl: number | null
          cac: number | null
          roas: number | null
        }[]
      }
      client_economics_by_campaign: {
        Args: { p_client_id: string; p_since: string; p_until: string }
        Returns: {
          campaign_id: string | null
          campaign_ref: string
          spend: number
          leads: number
          customers: number
          revenue: number
          cash_collected: number
          cpl: number | null
          cac: number | null
          roas: number | null
        }[]
      }
      advance_lead: {
        Args: { p_lead_id: string; p_stage: Database["public"]["Enums"]["lead_stage"]; p_note?: string }
        Returns: undefined
      }
      stalled_leads: {
        Args: { p_client_id: string; p_days?: number }
        Returns: {
          id: string
          name: string | null
          stage: Database["public"]["Enums"]["lead_stage"]
          days_in_stage: number
          next_action: string | null
          next_action_due: string | null
          overdue: boolean
          owner_name: string | null
          opportunity_value: number | null
        }[]
      }
      acquisition_funnel: {
        Args: { p_client_id: string; p_days?: number }
        Returns: {
          leads: number
          conversations: number
          appointments: number
          sales: number
          lost: number
          pipeline_value: number
          sale_value: number
          cash_collected: number
          spend: number
          lead_to_sale_pct: number | null
          cost_per_lead: number | null
          return_on_spend: number | null
        }[]
      }
      top_content_by_revenue: {
        Args: { p_client_id: string; p_limit?: number }
        Returns: {
          asset_ref: string | null
          asset_title: string | null
          hook: string | null
          idea_title: string | null
          content_territory: string | null
          leads: number
          sales: number
          cash_collected: number
          spend: number
          impressions: number
        }[]
      }
      review_media_asset: {
        Args: {
          p_asset_id: string
          p_decision: Database["public"]["Enums"]["review_status"]
          p_reason?: string
        }
        Returns: undefined
      }
      schedule_asset: {
        Args: {
          p_asset_id: string
          p_channel?: Database["public"]["Enums"]["post_channel"]
          p_date: string
        }
        Returns: string
      }
      select_render: { Args: { p_render_id: string }; Returns: undefined }
      start_master_run: { Args: { p_client_id: string }; Returns: string }
      start_master_run_as: {
        Args: { p_actor: string; p_client_id: string }
        Returns: string
      }
      start_onboarding: { Args: { p_client_id: string }; Returns: undefined }
      try_uuid: { Args: { t: string }; Returns: string }
      update_generation_concept: {
        Args: { p_concept: Json; p_generation_id: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "employee" | "client"
      brief_status:
        | "draft"
        | "approved"
        | "rejected"
        | "in_production"
        | "complete"
      build_route: "ai" | "human"
      campaign_status: "active" | "past"
      creative_stage: "concept" | "render" | "done" | "failed"
      engagement_type: "employee" | "contractor"
      idea_source: "manual" | "auto" | "proof"
      idea_status: "draft" | "approved" | "rejected" | "briefed"
      job_status:
        | "queued"
        | "claimed"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
      master_ai_scope: "client" | "company"
      media_type: "image" | "text" | "video"
      metric_basis: "daily" | "cumulative"
      metric_entity: "account" | "campaign" | "post" | "page"
      metric_surface: "paid" | "organic" | "landing" | "offer"
      page_type: "landing" | "offer"
      lead_stage: "lead" | "conversation" | "qualified_conversation" | "appointment" | "qualified_appointment" | "shown" | "sale" | "cash" | "lost"
      pipeline_stage: "first_touch" | "second_touch" | "call_booked"
      post_channel: "organic" | "paid"
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
      render_status: "queued" | "rendering" | "done" | "failed"
      review_status: "pending" | "approved" | "rejected"
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
  public: {
    Enums: {
      app_role: ["admin", "employee", "client"],
      brief_status: [
        "draft",
        "approved",
        "rejected",
        "in_production",
        "complete",
      ],
      build_route: ["ai", "human"],
      campaign_status: ["active", "past"],
      creative_stage: ["concept", "render", "done", "failed"],
      engagement_type: ["employee", "contractor"],
      idea_source: ["manual", "auto", "proof"],
      idea_status: ["draft", "approved", "rejected", "briefed"],
      job_status: [
        "queued",
        "claimed",
        "running",
        "completed",
        "failed",
        "cancelled",
      ],
      master_ai_scope: ["client", "company"],
      media_type: ["image", "text", "video"],
      metric_basis: ["daily", "cumulative"],
      metric_entity: ["account", "campaign", "post", "page"],
      metric_surface: ["paid", "organic", "landing", "offer"],
      page_type: ["landing", "offer"],
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
      ],
      pipeline_stage: ["first_touch", "second_touch", "call_booked"],
      post_channel: ["organic", "paid"],
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
      render_status: ["queued", "rendering", "done", "failed"],
      review_status: ["pending", "approved", "rejected"],
      step_status: ["pending", "in_progress", "complete"],
      team_category: ["avatars", "editors", "smm"],
    },
  },
} as const
