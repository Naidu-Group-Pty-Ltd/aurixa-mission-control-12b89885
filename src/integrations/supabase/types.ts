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
  public: {
    Tables: {
      addon_modules: {
        Row: {
          billing_period: string
          category: string
          created_at: string
          currency: string
          description: string | null
          id: string
          included_in_plans: string[]
          is_active: boolean
          metadata: Json
          name: string
          price_max_cents: number
          price_min_cents: number
          slug: string
          sort_order: number
          stripe_price_id: string | null
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          billing_period?: string
          category?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          included_in_plans?: string[]
          is_active?: boolean
          metadata?: Json
          name: string
          price_max_cents?: number
          price_min_cents?: number
          slug: string
          sort_order?: number
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          billing_period?: string
          category?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          included_in_plans?: string[]
          is_active?: boolean
          metadata?: Json
          name?: string
          price_max_cents?: number
          price_min_cents?: number
          slug?: string
          sort_order?: number
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ai_usage_log: {
        Row: {
          completion_tokens: number | null
          cost_estimate_usd: number | null
          created_at: string
          feature: string
          id: string
          metadata: Json
          model: string
          prompt_tokens: number | null
          total_tokens: number | null
          user_id: string | null
        }
        Insert: {
          completion_tokens?: number | null
          cost_estimate_usd?: number | null
          created_at?: string
          feature: string
          id?: string
          metadata?: Json
          model: string
          prompt_tokens?: number | null
          total_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          completion_tokens?: number | null
          cost_estimate_usd?: number | null
          created_at?: string
          feature?: string
          id?: string
          metadata?: Json
          model?: string
          prompt_tokens?: number | null
          total_tokens?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      api_provider_rates: {
        Row: {
          category: string
          cost_micros_per_unit: number
          created_at: string
          currency: string
          display_name: string
          id: string
          included_free_units: number
          is_active: boolean
          is_billable: boolean
          notes: string | null
          provider: string
          resale_micros_per_unit: number
          secret_name: string
          unit: string
          updated_at: string
        }
        Insert: {
          category?: string
          cost_micros_per_unit?: number
          created_at?: string
          currency?: string
          display_name: string
          id?: string
          included_free_units?: number
          is_active?: boolean
          is_billable?: boolean
          notes?: string | null
          provider: string
          resale_micros_per_unit?: number
          secret_name: string
          unit?: string
          updated_at?: string
        }
        Update: {
          category?: string
          cost_micros_per_unit?: number
          created_at?: string
          currency?: string
          display_name?: string
          id?: string
          included_free_units?: number
          is_active?: boolean
          is_billable?: boolean
          notes?: string | null
          provider?: string
          resale_micros_per_unit?: number
          secret_name?: string
          unit?: string
          updated_at?: string
        }
        Relationships: []
      }
      api_usage_charge_lines: {
        Row: {
          amount_micros: number
          billable_quantity: number
          byok_quantity: number
          charge_id: string
          charged_quantity: number
          display_name: string
          free_units_applied: number
          id: string
          provider: string
          rate_micros_per_unit: number
          secret_name: string
          unit: string
        }
        Insert: {
          amount_micros?: number
          billable_quantity?: number
          byok_quantity?: number
          charge_id: string
          charged_quantity?: number
          display_name: string
          free_units_applied?: number
          id?: string
          provider: string
          rate_micros_per_unit?: number
          secret_name: string
          unit: string
        }
        Update: {
          amount_micros?: number
          billable_quantity?: number
          byok_quantity?: number
          charge_id?: string
          charged_quantity?: number
          display_name?: string
          free_units_applied?: number
          id?: string
          provider?: string
          rate_micros_per_unit?: number
          secret_name?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_usage_charge_lines_charge_id_fkey"
            columns: ["charge_id"]
            isOneToOne: false
            referencedRelation: "api_usage_charges"
            referencedColumns: ["id"]
          },
        ]
      }
      api_usage_charges: {
        Row: {
          amount_cents: number
          amount_micros: number
          clone_id: string | null
          closed_at: string | null
          cost_micros: number
          created_at: string
          currency: string
          id: string
          invoiced_at: string | null
          last_error: string | null
          metadata: Json
          period_end: string
          period_start: string
          status: string
          stripe_customer_id: string | null
          stripe_invoice_item_id: string | null
          tenant_id: string
          updated_at: string
          waived_by: string | null
          waived_reason: string | null
        }
        Insert: {
          amount_cents?: number
          amount_micros?: number
          clone_id?: string | null
          closed_at?: string | null
          cost_micros?: number
          created_at?: string
          currency?: string
          id?: string
          invoiced_at?: string | null
          last_error?: string | null
          metadata?: Json
          period_end: string
          period_start: string
          status?: string
          stripe_customer_id?: string | null
          stripe_invoice_item_id?: string | null
          tenant_id: string
          updated_at?: string
          waived_by?: string | null
          waived_reason?: string | null
        }
        Update: {
          amount_cents?: number
          amount_micros?: number
          clone_id?: string | null
          closed_at?: string | null
          cost_micros?: number
          created_at?: string
          currency?: string
          id?: string
          invoiced_at?: string | null
          last_error?: string | null
          metadata?: Json
          period_end?: string
          period_start?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_invoice_item_id?: string | null
          tenant_id?: string
          updated_at?: string
          waived_by?: string | null
          waived_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_usage_charges_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_usage_charges_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "api_usage_charges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_usage_events: {
        Row: {
          billable: boolean
          billing_reason: string
          call_status: string
          clone_id: string | null
          cost_micros: number
          created_at: string
          currency: string
          feature: string | null
          id: string
          idempotency_key: string
          metadata: Json
          model: string | null
          occurred_at: string
          period_start: string
          provider: string
          quantity: number
          rated_micros: number
          secret_name: string
          tenant_id: string
          unit: string
        }
        Insert: {
          billable?: boolean
          billing_reason: string
          call_status?: string
          clone_id?: string | null
          cost_micros?: number
          created_at?: string
          currency?: string
          feature?: string | null
          id?: string
          idempotency_key: string
          metadata?: Json
          model?: string | null
          occurred_at?: string
          period_start: string
          provider: string
          quantity?: number
          rated_micros?: number
          secret_name: string
          tenant_id: string
          unit: string
        }
        Update: {
          billable?: boolean
          billing_reason?: string
          call_status?: string
          clone_id?: string | null
          cost_micros?: number
          created_at?: string
          currency?: string
          feature?: string | null
          id?: string
          idempotency_key?: string
          metadata?: Json
          model?: string | null
          occurred_at?: string
          period_start?: string
          provider?: string
          quantity?: number
          rated_micros?: number
          secret_name?: string
          tenant_id?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_usage_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_usage_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "api_usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_usage_rollups: {
        Row: {
          billable_quantity: number
          byok_quantity: number
          clone_id: string | null
          cost_micros: number
          currency: string
          error_count: number
          event_count: number
          first_seen_at: string
          gross_charge_micros: number
          gross_quantity: number
          id: string
          last_seen_at: string
          period_start: string
          provider: string
          secret_name: string
          tenant_id: string
          unit: string
        }
        Insert: {
          billable_quantity?: number
          byok_quantity?: number
          clone_id?: string | null
          cost_micros?: number
          currency?: string
          error_count?: number
          event_count?: number
          first_seen_at?: string
          gross_charge_micros?: number
          gross_quantity?: number
          id?: string
          last_seen_at?: string
          period_start: string
          provider: string
          secret_name: string
          tenant_id: string
          unit: string
        }
        Update: {
          billable_quantity?: number
          byok_quantity?: number
          clone_id?: string | null
          cost_micros?: number
          currency?: string
          error_count?: number
          event_count?: number
          first_seen_at?: string
          gross_charge_micros?: number
          gross_quantity?: number
          id?: string
          last_seen_at?: string
          period_start?: string
          provider?: string
          secret_name?: string
          tenant_id?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_usage_rollups_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_usage_rollups_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "api_usage_rollups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          metadata: Json
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
        }
        Relationships: []
      }
      billing_handoffs: {
        Row: {
          clone_id: string | null
          consumed_at: string | null
          contact_company: string | null
          contact_email: string | null
          contact_first_name: string | null
          contact_last_name: string | null
          contact_phone: string | null
          contact_tax_id: string | null
          contact_tax_id_type: string | null
          created_at: string
          expires_at: string
          id: string
          intent: string | null
          origin_source: string
          origin_user_id: string
          origin_username: string | null
          return_url: string | null
          tenant_id: string | null
        }
        Insert: {
          clone_id?: string | null
          consumed_at?: string | null
          contact_company?: string | null
          contact_email?: string | null
          contact_first_name?: string | null
          contact_last_name?: string | null
          contact_phone?: string | null
          contact_tax_id?: string | null
          contact_tax_id_type?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          intent?: string | null
          origin_source: string
          origin_user_id: string
          origin_username?: string | null
          return_url?: string | null
          tenant_id?: string | null
        }
        Update: {
          clone_id?: string | null
          consumed_at?: string | null
          contact_company?: string | null
          contact_email?: string | null
          contact_first_name?: string | null
          contact_last_name?: string | null
          contact_phone?: string | null
          contact_tax_id?: string | null
          contact_tax_id_type?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          intent?: string | null
          origin_source?: string
          origin_user_id?: string
          origin_username?: string | null
          return_url?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "billing_handoffs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_plans: {
        Row: {
          created_at: string
          currency: string
          id: string
          is_active: boolean
          metadata: Json
          monthly_allowance: number
          name: string
          overage_policy: Database["public"]["Enums"]["overage_policy"]
          price_cents: number
          rollover_cap: number
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          monthly_allowance?: number
          name: string
          overage_policy?: Database["public"]["Enums"]["overage_policy"]
          price_cents?: number
          rollover_cap?: number
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          monthly_allowance?: number
          name?: string
          overage_policy?: Database["public"]["Enums"]["overage_policy"]
          price_cents?: number
          rollover_cap?: number
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      cascade_approvals: {
        Row: {
          approver_user_id: string
          cascade_event_id: string
          created_at: string
          decision: string
          id: string
          reason: string | null
        }
        Insert: {
          approver_user_id: string
          cascade_event_id: string
          created_at?: string
          decision: string
          id?: string
          reason?: string | null
        }
        Update: {
          approver_user_id?: string
          cascade_event_id?: string
          created_at?: string
          decision?: string
          id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cascade_approvals_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
        ]
      }
      cascade_events: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          initiated_by: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          next_attempt_at: string
          requires_approval: boolean
          scope_filter: Json
          source_branch: string | null
          source_sha: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["cascade_event_status"]
          summary: string | null
          trigger: Database["public"]["Enums"]["cascade_trigger"]
          updated_at: string
          worker_finished_at: string | null
          worker_started_at: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          initiated_by?: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          next_attempt_at?: string
          requires_approval?: boolean
          scope_filter?: Json
          source_branch?: string | null
          source_sha?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_event_status"]
          summary?: string | null
          trigger: Database["public"]["Enums"]["cascade_trigger"]
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          initiated_by?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          next_attempt_at?: string
          requires_approval?: boolean
          scope_filter?: Json
          source_branch?: string | null
          source_sha?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_event_status"]
          summary?: string | null
          trigger?: Database["public"]["Enums"]["cascade_trigger"]
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Relationships: []
      }
      cascade_results: {
        Row: {
          cascade_event_id: string
          clone_id: string
          commit_sha: string | null
          completed_at: string | null
          created_at: string
          diff_summary: string | null
          error_message: string | null
          files_changed: number
          id: string
          pr_url: string | null
          previous_sha: string | null
          progress: Json | null
          started_at: string | null
          status: Database["public"]["Enums"]["cascade_result_status"]
          updated_at: string
        }
        Insert: {
          cascade_event_id: string
          clone_id: string
          commit_sha?: string | null
          completed_at?: string | null
          created_at?: string
          diff_summary?: string | null
          error_message?: string | null
          files_changed?: number
          id?: string
          pr_url?: string | null
          previous_sha?: string | null
          progress?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_result_status"]
          updated_at?: string
        }
        Update: {
          cascade_event_id?: string
          clone_id?: string
          commit_sha?: string | null
          completed_at?: string | null
          created_at?: string
          diff_summary?: string | null
          error_message?: string | null
          files_changed?: number
          id?: string
          pr_url?: string | null
          previous_sha?: string | null
          progress?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_result_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cascade_results_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cascade_results_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cascade_results_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      cascade_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          cron_expression: string
          enabled: boolean
          id: string
          kind: Database["public"]["Enums"]["cascade_schedule_kind"]
          last_cascade_event_id: string | null
          last_run_at: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          name: string
          next_run_at: string | null
          notes: string | null
          scope_filter: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cron_expression: string
          enabled?: boolean
          id?: string
          kind: Database["public"]["Enums"]["cascade_schedule_kind"]
          last_cascade_event_id?: string | null
          last_run_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name: string
          next_run_at?: string | null
          notes?: string | null
          scope_filter?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cron_expression?: string
          enabled?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["cascade_schedule_kind"]
          last_cascade_event_id?: string | null
          last_run_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name?: string
          next_run_at?: string | null
          notes?: string | null
          scope_filter?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cascade_schedules_last_cascade_event_id_fkey"
            columns: ["last_cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
        ]
      }
      cascade_templates: {
        Row: {
          clone_ids: string[]
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          last_used_at: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          name: string
          scope: string
          tags: string[]
          updated_at: string
          use_count: number
        }
        Insert: {
          clone_ids?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_used_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name: string
          scope?: string
          tags?: string[]
          updated_at?: string
          use_count?: number
        }
        Update: {
          clone_ids?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_used_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name?: string
          scope?: string
          tags?: string[]
          updated_at?: string
          use_count?: number
        }
        Relationships: []
      }
      client_agreements: {
        Row: {
          addon_slugs: string[]
          admin_email: string | null
          excluded_module_ids: string[]
          module_ids: string[]
          plan_slug: string | null
          provision_error: string | null
          provision_on_signature: boolean
          provision_region: string
          provision_status: string
          provisioned_clone_id: string | null
          account_id: string | null
          client_email: string
          client_name: string
          client_org: string | null
          commencement_date: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          docusign_envelope_id: string | null
          docusign_sent_at: string | null
          docusign_signed_at: string | null
          docusign_status: string | null
          docusign_voided_at: string | null
          id: string
          metadata: Json
          notes: string | null
          service_tier: string | null
          status: string
          updated_at: string
          void_reason: string | null
        }
        Insert: {
          addon_slugs?: string[]
          admin_email?: string | null
          excluded_module_ids?: string[]
          module_ids?: string[]
          plan_slug?: string | null
          provision_error?: string | null
          provision_on_signature?: boolean
          provision_region?: string
          provision_status?: string
          provisioned_clone_id?: string | null
          account_id?: string | null
          client_email: string
          client_name: string
          client_org?: string | null
          commencement_date?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          docusign_envelope_id?: string | null
          docusign_sent_at?: string | null
          docusign_signed_at?: string | null
          docusign_status?: string | null
          docusign_voided_at?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          service_tier?: string | null
          status?: string
          updated_at?: string
          void_reason?: string | null
        }
        Update: {
          addon_slugs?: string[]
          admin_email?: string | null
          excluded_module_ids?: string[]
          module_ids?: string[]
          plan_slug?: string | null
          provision_error?: string | null
          provision_on_signature?: boolean
          provision_region?: string
          provision_status?: string
          provisioned_clone_id?: string | null
          account_id?: string | null
          client_email?: string
          client_name?: string
          client_org?: string | null
          commencement_date?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          docusign_envelope_id?: string | null
          docusign_sent_at?: string | null
          docusign_signed_at?: string | null
          docusign_status?: string | null
          docusign_voided_at?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          service_tier?: string | null
          status?: string
          updated_at?: string
          void_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_agreements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      client_supabase_accounts: {
        Row: {
          clone_id: string | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          org_id: string | null
          org_slug: string | null
          owner_email: string
          owner_name: string | null
          pat_ciphertext: string | null
          pat_last4: string | null
          pat_nonce: string | null
          plan_tier: string | null
          region_allowed: string[]
          revoked_at: string | null
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          org_id?: string | null
          org_slug?: string | null
          owner_email: string
          owner_name?: string | null
          pat_ciphertext?: string | null
          pat_last4?: string | null
          pat_nonce?: string | null
          plan_tier?: string | null
          region_allowed?: string[]
          revoked_at?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          org_id?: string | null
          org_slug?: string | null
          owner_email?: string
          owner_name?: string | null
          pat_ciphertext?: string | null
          pat_last4?: string | null
          pat_nonce?: string | null
          plan_tier?: string | null
          region_allowed?: string[]
          revoked_at?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_supabase_accounts_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_supabase_accounts_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_addon_purchases: {
        Row: {
          addon_name: string | null
          addon_slug: string
          cancelled_at: string | null
          clone_id: string
          created_at: string
          created_by: string | null
          currency: string
          current_period_end: string | null
          external_ref: string | null
          id: string
          notes: string | null
          purchased_at: string
          quantity: number
          source: string
          status: string
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          stripe_subscription_item_id: string | null
          tenant_id: string | null
          unit_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          addon_name?: string | null
          addon_slug: string
          cancelled_at?: string | null
          clone_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          current_period_end?: string | null
          external_ref?: string | null
          id?: string
          notes?: string | null
          purchased_at?: string
          quantity?: number
          source?: string
          status?: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          stripe_subscription_item_id?: string | null
          tenant_id?: string | null
          unit_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          addon_name?: string | null
          addon_slug?: string
          cancelled_at?: string | null
          clone_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          current_period_end?: string | null
          external_ref?: string | null
          id?: string
          notes?: string | null
          purchased_at?: string
          quantity?: number
          source?: string
          status?: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          stripe_subscription_item_id?: string | null
          tenant_id?: string | null
          unit_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_addon_purchases_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_addon_purchases_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_addon_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_api_keys: {
        Row: {
          clone_id: string | null
          created_at: string
          created_by: string | null
          first_used_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at: string | null
          revoke_at: string | null
          revoked_at: string | null
          rotated_from: string | null
          rotated_to: string | null
          scopes: string[]
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          first_used_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at?: string | null
          revoke_at?: string | null
          revoked_at?: string | null
          rotated_from?: string | null
          rotated_to?: string | null
          scopes?: string[]
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          first_used_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          label?: string
          last_used_at?: string | null
          revoke_at?: string | null
          revoked_at?: string | null
          rotated_from?: string | null
          rotated_to?: string | null
          scopes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "clone_api_keys_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_api_keys_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_api_keys_rotated_from_fkey"
            columns: ["rotated_from"]
            isOneToOne: false
            referencedRelation: "clone_api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_api_keys_rotated_to_fkey"
            columns: ["rotated_to"]
            isOneToOne: false
            referencedRelation: "clone_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_secret_forwards: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_secret_forwards_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_backend_secrets: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          last_error: string | null
          last_set_at: string | null
          name: string
          set_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          last_error?: string | null
          last_set_at?: string | null
          name: string
          set_by?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          last_error?: string | null
          last_set_at?: string | null
          name?: string
          set_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_backend_secrets_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_backend_secrets_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_backends: {
        Row: {
          admin_email: string | null
          anon_key: string | null
          attempts: number
          clone_id: string
          created_at: string
          db_pass: string | null
          edge_functions: Json
          enqueued_by: string | null
          error_message: string | null
          id: string
          migration_version: string | null
          migrations_applied: Json
          parity_checked_at: string | null
          parity_report: Json | null
          queued_admin_password_enc: string | null
          queued_at: string | null
          queued_module_ids: string[] | null
          reference_sync_started_at: string | null
          repair_requested_at: string | null
          resume_stage: string | null
          retry_after: string | null
          region: string
          repo_retarget: Json | null
          secret_shells: Json
          service_role_key: string | null
          source_ref: string | null
          source_repo: string | null
          source_sha: string | null
          status: Database["public"]["Enums"]["clone_backend_status"]
          status_detail: string | null
          supabase_project_ref: string | null
          supabase_url: string | null
          updated_at: string
          worker_finished_at: string | null
          worker_started_at: string | null
        }
        Insert: {
          admin_email?: string | null
          anon_key?: string | null
          attempts?: number
          clone_id: string
          created_at?: string
          db_pass?: string | null
          edge_functions?: Json
          enqueued_by?: string | null
          error_message?: string | null
          id?: string
          migration_version?: string | null
          migrations_applied?: Json
          parity_checked_at?: string | null
          parity_report?: Json | null
          queued_admin_password_enc?: string | null
          queued_at?: string | null
          queued_module_ids?: string[] | null
          reference_sync_started_at?: string | null
          repair_requested_at?: string | null
          resume_stage?: string | null
          retry_after?: string | null
          region?: string
          repo_retarget?: Json | null
          secret_shells?: Json
          service_role_key?: string | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"]
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Update: {
          admin_email?: string | null
          anon_key?: string | null
          attempts?: number
          clone_id?: string
          created_at?: string
          db_pass?: string | null
          edge_functions?: Json
          enqueued_by?: string | null
          error_message?: string | null
          id?: string
          migration_version?: string | null
          migrations_applied?: Json
          parity_checked_at?: string | null
          parity_report?: Json | null
          queued_admin_password_enc?: string | null
          queued_at?: string | null
          queued_module_ids?: string[] | null
          reference_sync_started_at?: string | null
          repair_requested_at?: string | null
          resume_stage?: string | null
          retry_after?: string | null
          region?: string
          repo_retarget?: Json | null
          secret_shells?: Json
          service_role_key?: string | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"]
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Relationships: []
      }
      clone_brand_asset_variants: {
        Row: {
          byte_size: number | null
          content_type: string
          generated_at: string
          height: number | null
          id: string
          profile_id: string
          public_url: string
          source_path: string
          variant_kind: string
          variant_path: string
          width: number | null
        }
        Insert: {
          byte_size?: number | null
          content_type: string
          generated_at?: string
          height?: number | null
          id?: string
          profile_id: string
          public_url: string
          source_path: string
          variant_kind: string
          variant_path: string
          width?: number | null
        }
        Update: {
          byte_size?: number | null
          content_type?: string
          generated_at?: string
          height?: number | null
          id?: string
          profile_id?: string
          public_url?: string
          source_path?: string
          variant_kind?: string
          variant_path?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_asset_variants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_brand_assignments: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_config_hash: string | null
          clone_id: string
          created_at: string
          drift_summary: string | null
          error_message: string | null
          id: string
          last_drift_check_at: string | null
          override_keys: string[]
          overrides: Json
          profile_id: string
          status: Database["public"]["Enums"]["brand_assignment_status"]
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_config_hash?: string | null
          clone_id: string
          created_at?: string
          drift_summary?: string | null
          error_message?: string | null
          id?: string
          last_drift_check_at?: string | null
          override_keys?: string[]
          overrides?: Json
          profile_id: string
          status?: Database["public"]["Enums"]["brand_assignment_status"]
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_config_hash?: string | null
          clone_id?: string
          created_at?: string
          drift_summary?: string | null
          error_message?: string | null
          id?: string
          last_drift_check_at?: string | null
          override_keys?: string[]
          overrides?: Json
          profile_id?: string
          status?: Database["public"]["Enums"]["brand_assignment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_brand_history: {
        Row: {
          cascade_event_id: string | null
          clone_id: string
          config_hash: string | null
          config_snapshot: Json
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: string
          profile_id: string | null
          profile_version: number | null
          pushed_by: string | null
          status: Database["public"]["Enums"]["brand_assignment_status"]
        }
        Insert: {
          cascade_event_id?: string | null
          clone_id: string
          config_hash?: string | null
          config_snapshot?: Json
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          profile_id?: string | null
          profile_version?: number | null
          pushed_by?: string | null
          status?: Database["public"]["Enums"]["brand_assignment_status"]
        }
        Update: {
          cascade_event_id?: string | null
          clone_id?: string
          config_hash?: string | null
          config_snapshot?: Json
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          profile_id?: string | null
          profile_version?: number | null
          pushed_by?: string | null
          status?: Database["public"]["Enums"]["brand_assignment_status"]
        }
        Relationships: []
      }
      clone_brand_profiles: {
        Row: {
          asset_manifest: Json
          brand_config: Json
          config_hash: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_default: boolean
          name: string
          published_at: string | null
          published_by: string | null
          published_version_id: string | null
          report_contact: Json
          slug: string
          status: Database["public"]["Enums"]["brand_profile_status"]
          tags: string[]
          updated_at: string
          version: number
        }
        Insert: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          published_at?: string | null
          published_by?: string | null
          published_version_id?: string | null
          report_contact?: Json
          slug: string
          status?: Database["public"]["Enums"]["brand_profile_status"]
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Update: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          published_at?: string | null
          published_by?: string | null
          published_version_id?: string | null
          report_contact?: Json
          slug?: string
          status?: Database["public"]["Enums"]["brand_profile_status"]
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_profiles_published_version_id_fkey"
            columns: ["published_version_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_brand_versions: {
        Row: {
          asset_manifest: Json
          brand_config: Json
          config_hash: string | null
          created_at: string
          id: string
          notes: string | null
          profile_id: string
          published_at: string
          published_by: string | null
          report_contact: Json
          version: number
        }
        Insert: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          profile_id: string
          published_at?: string
          published_by?: string | null
          report_contact?: Json
          version: number
        }
        Update: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          profile_id?: string
          published_at?: string
          published_by?: string | null
          report_contact?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_versions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_turnstile_identities: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          domains: string[]
          fail_closed_at: string | null
          id: string
          last_error: string | null
          mode: string
          secret_last4: string | null
          secret_written_at: string | null
          site_key: string | null
          site_key_published_at: string | null
          status: string
          updated_at: string
          widget_name: string | null
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          domains?: string[]
          fail_closed_at?: string | null
          id?: string
          last_error?: string | null
          mode?: string
          secret_last4?: string | null
          secret_written_at?: string | null
          site_key?: string | null
          site_key_published_at?: string | null
          status?: string
          updated_at?: string
          widget_name?: string | null
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          domains?: string[]
          fail_closed_at?: string | null
          id?: string
          last_error?: string | null
          mode?: string
          secret_last4?: string | null
          secret_written_at?: string | null
          site_key?: string | null
          site_key_published_at?: string | null
          status?: string
          updated_at?: string
          widget_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_turnstile_identities_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_email_identities: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          default_from_address: string | null
          dns_installed_via: string | null
          from_address_written_at: string | null
          dns_records: Json
          domain_status: string
          id: string
          key_last4: string | null
          key_written_at: string | null
          last_error: string | null
          region: string
          revoked_at: string | null
          resend_domain_id: string | null
          resend_key_id: string | null
          sending_domain: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          default_from_address?: string | null
          dns_installed_via?: string | null
          from_address_written_at?: string | null
          dns_records?: Json
          domain_status?: string
          id?: string
          key_last4?: string | null
          key_written_at?: string | null
          last_error?: string | null
          region?: string
          revoked_at?: string | null
          resend_domain_id?: string | null
          resend_key_id?: string | null
          sending_domain: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          default_from_address?: string | null
          dns_installed_via?: string | null
          from_address_written_at?: string | null
          dns_records?: Json
          domain_status?: string
          id?: string
          key_last4?: string | null
          key_written_at?: string | null
          last_error?: string | null
          region?: string
          revoked_at?: string | null
          resend_domain_id?: string | null
          resend_key_id?: string | null
          sending_domain?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_email_identities_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_email_identities_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_deployments: {
        Row: {
          attempts: number
          build_checked_at: string | null
          clone_id: string
          created_at: string
          dns_target_type: string | null
          dns_target_value: string | null
          domain: string | null
          domain_verification: Json
          domain_verified_at: string | null
          env_digest: string | null
          env_synced_at: string | null
          error_message: string | null
          last_build_at: string | null
          last_build_deployment_id: string | null
          last_build_error: string | null
          last_build_state: string | null
          last_deployed_at: string | null
          latest_deployment_id: string | null
          max_attempts: number
          next_attempt_at: string
          project_id: string | null
          project_name: string | null
          provider_origin: string | null
          provider_slug: string
          requested_by: string | null
          status: string
          status_detail: string | null
          status_since: string
          team_id: string | null
          updated_at: string
          worker_finished_at: string | null
          worker_started_at: string | null
        }
        Insert: {
          attempts?: number
          build_checked_at?: string | null
          clone_id: string
          created_at?: string
          dns_target_type?: string | null
          dns_target_value?: string | null
          domain?: string | null
          domain_verification?: Json
          domain_verified_at?: string | null
          env_digest?: string | null
          env_synced_at?: string | null
          error_message?: string | null
          last_build_at?: string | null
          last_build_deployment_id?: string | null
          last_build_error?: string | null
          last_build_state?: string | null
          last_deployed_at?: string | null
          latest_deployment_id?: string | null
          max_attempts?: number
          next_attempt_at?: string
          project_id?: string | null
          project_name?: string | null
          provider_origin?: string | null
          provider_slug?: string
          requested_by?: string | null
          status?: string
          status_detail?: string | null
          status_since?: string
          team_id?: string | null
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Update: {
          attempts?: number
          build_checked_at?: string | null
          clone_id?: string
          created_at?: string
          dns_target_type?: string | null
          dns_target_value?: string | null
          domain?: string | null
          domain_verification?: Json
          domain_verified_at?: string | null
          env_digest?: string | null
          env_synced_at?: string | null
          error_message?: string | null
          last_build_at?: string | null
          last_build_deployment_id?: string | null
          last_build_error?: string | null
          last_build_state?: string | null
          last_deployed_at?: string | null
          latest_deployment_id?: string | null
          max_attempts?: number
          next_attempt_at?: string
          project_id?: string | null
          project_name?: string | null
          provider_origin?: string | null
          provider_slug?: string
          requested_by?: string | null
          status?: string
          status_detail?: string | null
          status_since?: string
          team_id?: string | null
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_deployments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_deployments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_deployments_provider_slug_fkey"
            columns: ["provider_slug"]
            isOneToOne: false
            referencedRelation: "hosting_providers"
            referencedColumns: ["slug"]
          },
        ]
      }
      clone_drift_policies: {
        Row: {
          auto_apply_severity: Database["public"]["Enums"]["drift_severity"]
          cascade_mode: Database["public"]["Enums"]["cascade_mode"]
          clone_id: string
          created_at: string
          enabled: boolean
          id: string
          last_applied_at: string | null
          last_applied_count: number
          max_per_run: number
          muted_kinds: string[]
          updated_at: string
        }
        Insert: {
          auto_apply_severity?: Database["public"]["Enums"]["drift_severity"]
          cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          clone_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_applied_at?: string | null
          last_applied_count?: number
          max_per_run?: number
          muted_kinds?: string[]
          updated_at?: string
        }
        Update: {
          auto_apply_severity?: Database["public"]["Enums"]["drift_severity"]
          cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          clone_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_applied_at?: string | null
          last_applied_count?: number
          max_per_run?: number
          muted_kinds?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_drift_policies_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_drift_policies_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_edge_config: {
        Row: {
          account_ref: string | null
          bot_fight: boolean
          clone_id: string
          created_at: string
          created_by: string | null
          custom_rules: Json
          drift: Json | null
          external_ref: string | null
          hostname: string | null
          id: string
          last_synced_at: string | null
          posture_preset: string | null
          provider_slug: string
          rate_limit_rps: number | null
          security_level: string | null
          status: string
          status_detail: string | null
          updated_at: string
          waf_preset: string | null
        }
        Insert: {
          account_ref?: string | null
          bot_fight?: boolean
          clone_id: string
          created_at?: string
          created_by?: string | null
          custom_rules?: Json
          drift?: Json | null
          external_ref?: string | null
          hostname?: string | null
          id?: string
          last_synced_at?: string | null
          posture_preset?: string | null
          provider_slug: string
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          waf_preset?: string | null
        }
        Update: {
          account_ref?: string | null
          bot_fight?: boolean
          clone_id?: string
          created_at?: string
          created_by?: string | null
          custom_rules?: Json
          drift?: Json | null
          external_ref?: string | null
          hostname?: string | null
          id?: string
          last_synced_at?: string | null
          posture_preset?: string | null
          provider_slug?: string
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          waf_preset?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_edge_config_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_edge_config_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_edge_config_posture_preset_fkey"
            columns: ["posture_preset"]
            isOneToOne: false
            referencedRelation: "edge_posture_presets"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "clone_edge_config_provider_slug_fkey"
            columns: ["provider_slug"]
            isOneToOne: false
            referencedRelation: "edge_providers"
            referencedColumns: ["slug"]
          },
        ]
      }
      clone_entitlement_reconciliations: {
        Row: {
          cascade_event_id: string | null
          clone_id: string
          created_at: string
          direction: string
          error_message: string | null
          from_plan_slug: string | null
          id: string
          installed_slugs: string[]
          ok: boolean
          plan_change_event_id: string | null
          revoked_slugs: string[]
          to_plan_slug: string
          triggered_by: string | null
          unchanged_count: number
          unmapped: Json
        }
        Insert: {
          cascade_event_id?: string | null
          clone_id: string
          created_at?: string
          direction: string
          error_message?: string | null
          from_plan_slug?: string | null
          id?: string
          installed_slugs?: string[]
          ok?: boolean
          plan_change_event_id?: string | null
          revoked_slugs?: string[]
          to_plan_slug: string
          triggered_by?: string | null
          unchanged_count?: number
          unmapped?: Json
        }
        Update: {
          cascade_event_id?: string | null
          clone_id?: string
          created_at?: string
          direction?: string
          error_message?: string | null
          from_plan_slug?: string | null
          id?: string
          installed_slugs?: string[]
          ok?: boolean
          plan_change_event_id?: string | null
          revoked_slugs?: string[]
          to_plan_slug?: string
          triggered_by?: string | null
          unchanged_count?: number
          unmapped?: Json
        }
        Relationships: [
          {
            foreignKeyName: "clone_entitlement_reconciliations_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_entitlement_reconciliations_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_handoffs: {
        Row: {
          backend_id: string | null
          client_account_id: string | null
          clone_id: string
          completed_at: string | null
          consent_signed_at: string | null
          consent_terms_version: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          initiated_at: string | null
          metadata: Json
          path: Database["public"]["Enums"]["handoff_path"]
          policy_id: string | null
          rollback_snapshot_id: string | null
          state: Database["public"]["Enums"]["handoff_state"]
          target_plan_tier: string | null
          target_project_ref: string | null
          target_project_url: string | null
          target_region: string | null
          updated_at: string
        }
        Insert: {
          backend_id?: string | null
          client_account_id?: string | null
          clone_id: string
          completed_at?: string | null
          consent_signed_at?: string | null
          consent_terms_version?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          initiated_at?: string | null
          metadata?: Json
          path?: Database["public"]["Enums"]["handoff_path"]
          policy_id?: string | null
          rollback_snapshot_id?: string | null
          state?: Database["public"]["Enums"]["handoff_state"]
          target_plan_tier?: string | null
          target_project_ref?: string | null
          target_project_url?: string | null
          target_region?: string | null
          updated_at?: string
        }
        Update: {
          backend_id?: string | null
          client_account_id?: string | null
          clone_id?: string
          completed_at?: string | null
          consent_signed_at?: string | null
          consent_terms_version?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          initiated_at?: string | null
          metadata?: Json
          path?: Database["public"]["Enums"]["handoff_path"]
          policy_id?: string | null
          rollback_snapshot_id?: string | null
          state?: Database["public"]["Enums"]["handoff_state"]
          target_plan_tier?: string | null
          target_project_ref?: string | null
          target_project_url?: string | null
          target_region?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_handoffs_backend_id_fkey"
            columns: ["backend_id"]
            isOneToOne: false
            referencedRelation: "clone_backends"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_backend_id_fkey"
            columns: ["backend_id"]
            isOneToOne: false
            referencedRelation: "clone_backends_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_supabase_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_handoffs_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "handoff_region_plan_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_rollback_snapshot_fk"
            columns: ["rollback_snapshot_id"]
            isOneToOne: false
            referencedRelation: "handoff_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_health_beacons: {
        Row: {
          active_connections: number | null
          api_p95_ms: number | null
          clone_id: string
          created_at: string
          db_size_bytes: number | null
          edge_invocations_24h: number | null
          error_count_24h: number | null
          handoff_id: string | null
          id: string
          message: string | null
          payload: Json
          project_ref: string | null
          project_status: string | null
          reported_at: string
          severity: string | null
          source: string
          storage_used_bytes: number | null
        }
        Insert: {
          active_connections?: number | null
          api_p95_ms?: number | null
          clone_id: string
          created_at?: string
          db_size_bytes?: number | null
          edge_invocations_24h?: number | null
          error_count_24h?: number | null
          handoff_id?: string | null
          id?: string
          message?: string | null
          payload?: Json
          project_ref?: string | null
          project_status?: string | null
          reported_at?: string
          severity?: string | null
          source: string
          storage_used_bytes?: number | null
        }
        Update: {
          active_connections?: number | null
          api_p95_ms?: number | null
          clone_id?: string
          created_at?: string
          db_size_bytes?: number | null
          edge_invocations_24h?: number | null
          error_count_24h?: number | null
          handoff_id?: string | null
          id?: string
          message?: string | null
          payload?: Json
          project_ref?: string | null
          project_status?: string | null
          reported_at?: string
          severity?: string | null
          source?: string
          storage_used_bytes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_health_beacons_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_health_beacons_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_health_beacons_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_health_snapshots: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          payload: Json
          probed_at: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          payload: Json
          probed_at?: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          payload?: Json
          probed_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_health_snapshots_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_health_snapshots_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_library_pins: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          library_entry_id: string
          notes: string | null
          pinned_at: string
          pinned_by: string | null
          slug: string
          updated_at: string
          version: number
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          library_entry_id: string
          notes?: string | null
          pinned_at?: string
          pinned_by?: string | null
          slug: string
          updated_at?: string
          version: number
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          library_entry_id?: string
          notes?: string | null
          pinned_at?: string
          pinned_by?: string | null
          slug?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      clone_modules: {
        Row: {
          clone_id: string
          id: string
          installed_at: string
          installed_by: string | null
          module_id: string
          version: string | null
        }
        Insert: {
          clone_id: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          module_id: string
          version?: string | null
        }
        Update: {
          clone_id?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          module_id?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_modules_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_modules_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_modules_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_payment_gate_events: {
        Row: {
          actor: string
          actor_id: string | null
          clone_id: string
          created_at: string
          gate_id: string
          id: string
          kind: string
          metadata: Json
          reason: string | null
          status_after: string | null
          status_before: string | null
        }
        Insert: {
          actor?: string
          actor_id?: string | null
          clone_id: string
          created_at?: string
          gate_id: string
          id?: string
          kind: string
          metadata?: Json
          reason?: string | null
          status_after?: string | null
          status_before?: string | null
        }
        Update: {
          actor?: string
          actor_id?: string | null
          clone_id?: string
          created_at?: string
          gate_id?: string
          id?: string
          kind?: string
          metadata?: Json
          reason?: string | null
          status_after?: string | null
          status_before?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_payment_gate_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_payment_gate_events_gate_id_fkey"
            columns: ["gate_id"]
            isOneToOne: false
            referencedRelation: "clone_payment_gates"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_payment_gates: {
        Row: {
          amount_due_cents: number | null
          amount_paid_cents: number | null
          armed_at: string
          check_count: number
          clone_id: string
          created_at: string
          currency: string
          first_locked_seen_at: string | null
          grace_hours: number | null
          id: string
          last_checked_at: string | null
          locks_at: string | null
          manual_override: string | null
          manual_override_at: string | null
          manual_override_by: string | null
          manual_override_reason: string | null
          notes: string | null
          paid_at: string | null
          payment_source: string | null
          plan_name: string | null
          plan_slug: string | null
          stripe_checkout_session_id: string | null
          stripe_customer_id: string | null
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          amount_due_cents?: number | null
          amount_paid_cents?: number | null
          armed_at?: string
          check_count?: number
          clone_id: string
          created_at?: string
          currency?: string
          first_locked_seen_at?: string | null
          grace_hours?: number | null
          id?: string
          last_checked_at?: string | null
          locks_at?: string | null
          manual_override?: string | null
          manual_override_at?: string | null
          manual_override_by?: string | null
          manual_override_reason?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_source?: string | null
          plan_name?: string | null
          plan_slug?: string | null
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_due_cents?: number | null
          amount_paid_cents?: number | null
          armed_at?: string
          check_count?: number
          clone_id?: string
          created_at?: string
          currency?: string
          first_locked_seen_at?: string | null
          grace_hours?: number | null
          id?: string
          last_checked_at?: string | null
          locks_at?: string | null
          manual_override?: string | null
          manual_override_at?: string | null
          manual_override_by?: string | null
          manual_override_reason?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_source?: string | null
          plan_name?: string | null
          plan_slug?: string | null
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_payment_gates_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_reference_syncs: {
        Row: {
          clone_id: string
          completed_at: string | null
          cursor: string | null
          detail: string | null
          rows_copied: number
          source_rows: number | null
          started_at: string | null
          status: string
          table_name: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          completed_at?: string | null
          cursor?: string | null
          detail?: string | null
          rows_copied?: number
          source_rows?: number | null
          started_at?: string | null
          status?: string
          table_name: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          completed_at?: string | null
          cursor?: string | null
          detail?: string | null
          rows_copied?: number
          source_rows?: number | null
          started_at?: string | null
          status?: string
          table_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_reference_syncs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_reference_syncs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_seat_devices: {
        Row: {
          clone_id: string | null
          created_at: string
          device_fingerprint: string
          device_label: string | null
          external_user_id: string
          first_seen_at: string
          id: string
          ip_address: string | null
          last_seen_at: string
          metadata: Json
          platform: string | null
          revoked_at: string | null
          revoked_reason: string | null
          seat_id: string
          status: string
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          device_fingerprint: string
          device_label?: string | null
          external_user_id: string
          first_seen_at?: string
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          metadata?: Json
          platform?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          seat_id: string
          status?: string
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          device_fingerprint?: string
          device_label?: string | null
          external_user_id?: string
          first_seen_at?: string
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          metadata?: Json
          platform?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          seat_id?: string
          status?: string
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_seat_devices_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "clone_seats"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_seat_entitlements: {
        Row: {
          canceled_at: string | null
          clone_id: string | null
          created_at: string
          current_period_end: string | null
          expires_at: string | null
          granted_at: string
          id: string
          notes: string | null
          past_due_at: string | null
          seat_plan_id: string
          seats_used: number
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          canceled_at?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          expires_at?: string | null
          granted_at?: string
          id?: string
          notes?: string | null
          past_due_at?: string | null
          seat_plan_id: string
          seats_used?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          canceled_at?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          expires_at?: string | null
          granted_at?: string
          id?: string
          notes?: string | null
          past_due_at?: string | null
          seat_plan_id?: string
          seats_used?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_seat_entitlements_seat_plan_id_fkey"
            columns: ["seat_plan_id"]
            isOneToOne: false
            referencedRelation: "seat_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_seats: {
        Row: {
          clone_id: string | null
          committed_at: string | null
          created_at: string
          device_count: number
          display_name: string | null
          email: string | null
          external_user_id: string
          id: string
          idempotency_key: string | null
          metadata: Json
          removed_at: string | null
          reservation_expires_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          clone_id?: string | null
          committed_at?: string | null
          created_at?: string
          device_count?: number
          display_name?: string | null
          email?: string | null
          external_user_id: string
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          removed_at?: string | null
          reservation_expires_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          clone_id?: string | null
          committed_at?: string | null
          created_at?: string
          device_count?: number
          display_name?: string | null
          email?: string | null
          external_user_id?: string
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          removed_at?: string | null
          reservation_expires_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      clone_stripe_configs: {
        Row: {
          activated_at: string | null
          clone_id: string
          created_at: string
          created_by: string | null
          forward_url: string | null
          metadata: Json
          mode: Database["public"]["Enums"]["clone_stripe_mode"]
          rotated_at: string | null
          status: Database["public"]["Enums"]["clone_stripe_status"]
          stripe_account_id: string | null
          updated_at: string
          webhook_secret_ciphertext: string | null
          webhook_secret_last4: string | null
        }
        Insert: {
          activated_at?: string | null
          clone_id: string
          created_at?: string
          created_by?: string | null
          forward_url?: string | null
          metadata?: Json
          mode?: Database["public"]["Enums"]["clone_stripe_mode"]
          rotated_at?: string | null
          status?: Database["public"]["Enums"]["clone_stripe_status"]
          stripe_account_id?: string | null
          updated_at?: string
          webhook_secret_ciphertext?: string | null
          webhook_secret_last4?: string | null
        }
        Update: {
          activated_at?: string | null
          clone_id?: string
          created_at?: string
          created_by?: string | null
          forward_url?: string | null
          metadata?: Json
          mode?: Database["public"]["Enums"]["clone_stripe_mode"]
          rotated_at?: string | null
          status?: Database["public"]["Enums"]["clone_stripe_status"]
          stripe_account_id?: string | null
          updated_at?: string
          webhook_secret_ciphertext?: string | null
          webhook_secret_last4?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_stripe_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_stripe_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_sync_exclusions: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          note: string | null
          pattern: string
          reason: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          note?: string | null
          pattern: string
          reason?: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          note?: string | null
          pattern?: string
          reason?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_sync_exclusions_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_sync_exclusions_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clones: {
        Row: {
          billing_stripe_customer_id: string | null
          billing_user_id: string | null
          cloudflare_enabled: boolean
          cloudflare_zone_id: string | null
          codex_nightly_enabled: boolean
          commits_behind: number
          created_at: string
          default_branch: string
          deploy_url: string | null
          drift_suggestions: Json
          contract_excluded_module_slugs: string[]
          entitled_module_slugs: string[]
          entitled_plan_slug: string | null
          entitlement_keys: string[]
          entitlements_synced_at: string | null
          github_app_installation_id: string | null
          github_owner: string
          github_repo: string
          github_url: string | null
          id: string
          idempotency_key: string | null
          isolated_tenant: boolean
          last_cascade_at: string | null
          last_drift_check_at: string | null
          last_synced_sha: string | null
          lovable_project_id: string | null
          lovable_project_url: string | null
          name: string
          notes: string | null
          owner_user_id: string | null
          provisioning_method: Database["public"]["Enums"]["provisioning_method"]
          purchased_addon_slugs: string[]
          repo_full_name: string | null
          revoked_module_slugs: string[]
          slug: string
          subdomain: string | null
          subdomain_fqdn: string | null
          subdomain_status: string | null
          sync_scope: string
          sync_status: Database["public"]["Enums"]["sync_status"]
          tags: string[] | null
          updated_at: string
        }
        Insert: {
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          cloudflare_enabled?: boolean
          cloudflare_zone_id?: string | null
          codex_nightly_enabled?: boolean
          commits_behind?: number
          created_at?: string
          default_branch?: string
          deploy_url?: string | null
          drift_suggestions?: Json
          contract_excluded_module_slugs?: string[]
          entitled_module_slugs?: string[]
          entitled_plan_slug?: string | null
          entitlement_keys?: string[]
          entitlements_synced_at?: string | null
          github_app_installation_id?: string | null
          github_owner: string
          github_repo: string
          github_url?: string | null
          id?: string
          idempotency_key?: string | null
          isolated_tenant?: boolean
          last_cascade_at?: string | null
          last_drift_check_at?: string | null
          last_synced_sha?: string | null
          lovable_project_id?: string | null
          lovable_project_url?: string | null
          name: string
          notes?: string | null
          owner_user_id?: string | null
          provisioning_method: Database["public"]["Enums"]["provisioning_method"]
          purchased_addon_slugs?: string[]
          repo_full_name?: string | null
          revoked_module_slugs?: string[]
          slug: string
          subdomain?: string | null
          subdomain_fqdn?: string | null
          subdomain_status?: string | null
          sync_scope?: string
          sync_status?: Database["public"]["Enums"]["sync_status"]
          tags?: string[] | null
          updated_at?: string
        }
        Update: {
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          cloudflare_enabled?: boolean
          cloudflare_zone_id?: string | null
          codex_nightly_enabled?: boolean
          commits_behind?: number
          created_at?: string
          default_branch?: string
          deploy_url?: string | null
          drift_suggestions?: Json
          contract_excluded_module_slugs?: string[]
          entitled_module_slugs?: string[]
          entitled_plan_slug?: string | null
          entitlement_keys?: string[]
          entitlements_synced_at?: string | null
          github_app_installation_id?: string | null
          github_owner?: string
          github_repo?: string
          github_url?: string | null
          id?: string
          idempotency_key?: string | null
          isolated_tenant?: boolean
          last_cascade_at?: string | null
          last_drift_check_at?: string | null
          last_synced_sha?: string | null
          lovable_project_id?: string | null
          lovable_project_url?: string | null
          name?: string
          notes?: string | null
          owner_user_id?: string | null
          provisioning_method?: Database["public"]["Enums"]["provisioning_method"]
          purchased_addon_slugs?: string[]
          repo_full_name?: string | null
          revoked_module_slugs?: string[]
          slug?: string
          subdomain?: string | null
          subdomain_fqdn?: string | null
          subdomain_status?: string | null
          sync_scope?: string
          sync_status?: Database["public"]["Enums"]["sync_status"]
          tags?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      cloudflare_accounts: {
        Row: {
          account_id: string
          account_name: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean
          token_secret_name: string
          updated_at: string
        }
        Insert: {
          account_id: string
          account_name?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          token_secret_name?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          account_name?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          token_secret_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      cloudflare_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string | null
          created_at: string
          error_message: string | null
          id: string
          payload: Json
          result: Json
          success: boolean
          zone_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          payload?: Json
          result?: Json
          success?: boolean
          zone_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          payload?: Json
          result?: Json
          success?: boolean
          zone_id?: string | null
        }
        Relationships: []
      }
      cloudflare_clone_config: {
        Row: {
          account_id: string
          bot_fight_mode: boolean
          clone_id: string
          created_at: string
          id: string
          last_synced_at: string | null
          plan: string | null
          posture: Json
          rate_limit_rps: number | null
          security_level: string | null
          status: string
          updated_at: string
          waf_preset: string | null
          zone_id: string
          zone_name: string
        }
        Insert: {
          account_id: string
          bot_fight_mode?: boolean
          clone_id: string
          created_at?: string
          id?: string
          last_synced_at?: string | null
          plan?: string | null
          posture?: Json
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          updated_at?: string
          waf_preset?: string | null
          zone_id: string
          zone_name: string
        }
        Update: {
          account_id?: string
          bot_fight_mode?: boolean
          clone_id?: string
          created_at?: string
          id?: string
          last_synced_at?: string | null
          plan?: string | null
          posture?: Json
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          updated_at?: string
          waf_preset?: string | null
          zone_id?: string
          zone_name?: string
        }
        Relationships: []
      }
      codex_findings: {
        Row: {
          affected_file: string | null
          affected_line: number | null
          auto_fix_confidence: number | null
          clone_id: string | null
          codex_finding_id: string
          created_at: string
          cvss: number | null
          cwe: string | null
          description: string | null
          external_ticket_url: string | null
          fingerprint: string | null
          first_seen_at: string
          id: string
          last_seen_at: string
          raw: Json
          remediation_pr_state: string | null
          remediation_pr_url: string | null
          resolved_at: string | null
          rule_id: string | null
          scan_job_id: string | null
          scanner: string | null
          severity: Database["public"]["Enums"]["codex_finding_severity"]
          snippet: string | null
          source_slug: string | null
          state: Database["public"]["Enums"]["codex_finding_state"]
          title: string
          updated_at: string
        }
        Insert: {
          affected_file?: string | null
          affected_line?: number | null
          auto_fix_confidence?: number | null
          clone_id?: string | null
          codex_finding_id: string
          created_at?: string
          cvss?: number | null
          cwe?: string | null
          description?: string | null
          external_ticket_url?: string | null
          fingerprint?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          raw?: Json
          remediation_pr_state?: string | null
          remediation_pr_url?: string | null
          resolved_at?: string | null
          rule_id?: string | null
          scan_job_id?: string | null
          scanner?: string | null
          severity?: Database["public"]["Enums"]["codex_finding_severity"]
          snippet?: string | null
          source_slug?: string | null
          state?: Database["public"]["Enums"]["codex_finding_state"]
          title: string
          updated_at?: string
        }
        Update: {
          affected_file?: string | null
          affected_line?: number | null
          auto_fix_confidence?: number | null
          clone_id?: string | null
          codex_finding_id?: string
          created_at?: string
          cvss?: number | null
          cwe?: string | null
          description?: string | null
          external_ticket_url?: string | null
          fingerprint?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          raw?: Json
          remediation_pr_state?: string | null
          remediation_pr_url?: string | null
          resolved_at?: string | null
          rule_id?: string | null
          scan_job_id?: string | null
          scanner?: string | null
          severity?: Database["public"]["Enums"]["codex_finding_severity"]
          snippet?: string | null
          source_slug?: string | null
          state?: Database["public"]["Enums"]["codex_finding_state"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "codex_findings_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "codex_findings_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "codex_findings_scan_job_id_fkey"
            columns: ["scan_job_id"]
            isOneToOne: false
            referencedRelation: "codex_scan_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      codex_remediation_reviews: {
        Row: {
          comment: string | null
          created_at: string
          decision: string
          id: string
          remediation_id: string
          reviewer_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          decision: string
          id?: string
          remediation_id: string
          reviewer_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          decision?: string
          id?: string
          remediation_id?: string
          reviewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "codex_remediation_reviews_remediation_id_fkey"
            columns: ["remediation_id"]
            isOneToOne: false
            referencedRelation: "codex_remediations"
            referencedColumns: ["id"]
          },
        ]
      }
      codex_remediations: {
        Row: {
          approvals_required: number
          base_ref: string
          branch_name: string | null
          cascade_event_id: string | null
          clone_id: string | null
          completed_at: string | null
          created_at: string
          dispatch_payload: Json
          dispatched_at: string | null
          engine: string
          files_changed: number | null
          finding_id: string
          fix_confirmed_at: string | null
          fix_confirmed_by_job_id: string | null
          id: string
          last_error: string | null
          last_event: Json
          lines_added: number | null
          lines_removed: number | null
          merge_commit_sha: string | null
          merged_at: string | null
          merged_by: string | null
          model: string | null
          pr_number: number | null
          pr_state: string | null
          pr_url: string | null
          rejected_at: string | null
          rejected_by: string | null
          rejected_reason: string | null
          repo_full_name: string
          requested_by: string | null
          scan_job_id: string | null
          status: Database["public"]["Enums"]["codex_remediation_status"]
          updated_at: string
          verification: Json
          verified: boolean | null
          workflow_run_id: number | null
          workflow_run_url: string | null
        }
        Insert: {
          approvals_required?: number
          base_ref: string
          branch_name?: string | null
          cascade_event_id?: string | null
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          dispatch_payload?: Json
          dispatched_at?: string | null
          engine?: string
          files_changed?: number | null
          finding_id: string
          fix_confirmed_at?: string | null
          fix_confirmed_by_job_id?: string | null
          id?: string
          last_error?: string | null
          last_event?: Json
          lines_added?: number | null
          lines_removed?: number | null
          merge_commit_sha?: string | null
          merged_at?: string | null
          merged_by?: string | null
          model?: string | null
          pr_number?: number | null
          pr_state?: string | null
          pr_url?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_reason?: string | null
          repo_full_name: string
          requested_by?: string | null
          scan_job_id?: string | null
          status?: Database["public"]["Enums"]["codex_remediation_status"]
          updated_at?: string
          verification?: Json
          verified?: boolean | null
          workflow_run_id?: number | null
          workflow_run_url?: string | null
        }
        Update: {
          approvals_required?: number
          base_ref?: string
          branch_name?: string | null
          cascade_event_id?: string | null
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          dispatch_payload?: Json
          dispatched_at?: string | null
          engine?: string
          files_changed?: number | null
          finding_id?: string
          fix_confirmed_at?: string | null
          fix_confirmed_by_job_id?: string | null
          id?: string
          last_error?: string | null
          last_event?: Json
          lines_added?: number | null
          lines_removed?: number | null
          merge_commit_sha?: string | null
          merged_at?: string | null
          merged_by?: string | null
          model?: string | null
          pr_number?: number | null
          pr_state?: string | null
          pr_url?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_reason?: string | null
          repo_full_name?: string
          requested_by?: string | null
          scan_job_id?: string | null
          status?: Database["public"]["Enums"]["codex_remediation_status"]
          updated_at?: string
          verification?: Json
          verified?: boolean | null
          workflow_run_id?: number | null
          workflow_run_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "codex_remediations_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "codex_remediations_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "codex_remediations_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "codex_remediations_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "codex_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "codex_remediations_fix_confirmed_by_job_id_fkey"
            columns: ["fix_confirmed_by_job_id"]
            isOneToOne: false
            referencedRelation: "codex_scan_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "codex_remediations_scan_job_id_fkey"
            columns: ["scan_job_id"]
            isOneToOne: false
            referencedRelation: "codex_scan_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      codex_scan_events: {
        Row: {
          actor: string | null
          created_at: string
          event_type: string
          id: string
          job_id: string
          payload: Json
        }
        Insert: {
          actor?: string | null
          created_at?: string
          event_type: string
          id?: string
          job_id: string
          payload?: Json
        }
        Update: {
          actor?: string | null
          created_at?: string
          event_type?: string
          id?: string
          job_id?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "codex_scan_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "codex_scan_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      codex_scan_jobs: {
        Row: {
          clone_id: string | null
          completed_at: string | null
          created_at: string
          engine: string
          external_scan_id: string | null
          failure_count: number
          id: string
          kind: Database["public"]["Enums"]["codex_scan_kind"]
          last_error: string | null
          next_attempt_at: string | null
          path_globs: string[] | null
          ref: string | null
          repo_full_name: string
          request_payload: Json
          requested_by: string | null
          result_summary: Json
          started_at: string | null
          status: Database["public"]["Enums"]["codex_scan_status"]
          target_kind: string
          updated_at: string
          workflow_run_id: number | null
          workflow_run_url: string | null
        }
        Insert: {
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          engine?: string
          external_scan_id?: string | null
          failure_count?: number
          id?: string
          kind?: Database["public"]["Enums"]["codex_scan_kind"]
          last_error?: string | null
          next_attempt_at?: string | null
          path_globs?: string[] | null
          ref?: string | null
          repo_full_name: string
          request_payload?: Json
          requested_by?: string | null
          result_summary?: Json
          started_at?: string | null
          status?: Database["public"]["Enums"]["codex_scan_status"]
          target_kind?: string
          updated_at?: string
          workflow_run_id?: number | null
          workflow_run_url?: string | null
        }
        Update: {
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          engine?: string
          external_scan_id?: string | null
          failure_count?: number
          id?: string
          kind?: Database["public"]["Enums"]["codex_scan_kind"]
          last_error?: string | null
          next_attempt_at?: string | null
          path_globs?: string[] | null
          ref?: string | null
          repo_full_name?: string
          request_payload?: Json
          requested_by?: string | null
          result_summary?: Json
          started_at?: string | null
          status?: Database["public"]["Enums"]["codex_scan_status"]
          target_kind?: string
          updated_at?: string
          workflow_run_id?: number | null
          workflow_run_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "codex_scan_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "codex_scan_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      crm_accounts: {
        Row: {
          arr_cents: number
          classification: string | null
          clone_id: string | null
          created_at: string
          created_by: string | null
          health_computed_at: string | null
          health_score: number | null
          id: string
          last_contacted_at: string | null
          lifecycle_stage: Database["public"]["Enums"]["crm_lifecycle_stage"]
          metadata: Json
          mrr_cents: number
          name: string
          notes: string | null
          owner_user_id: string | null
          slug: string | null
          source: string | null
          tags: string[]
          tenant_id: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          arr_cents?: number
          classification?: string | null
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          health_computed_at?: string | null
          health_score?: number | null
          id?: string
          last_contacted_at?: string | null
          lifecycle_stage?: Database["public"]["Enums"]["crm_lifecycle_stage"]
          metadata?: Json
          mrr_cents?: number
          name: string
          notes?: string | null
          owner_user_id?: string | null
          slug?: string | null
          source?: string | null
          tags?: string[]
          tenant_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          arr_cents?: number
          classification?: string | null
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          health_computed_at?: string | null
          health_score?: number | null
          id?: string
          last_contacted_at?: string | null
          lifecycle_stage?: Database["public"]["Enums"]["crm_lifecycle_stage"]
          metadata?: Json
          mrr_cents?: number
          name?: string
          notes?: string | null
          owner_user_id?: string | null
          slug?: string | null
          source?: string | null
          tags?: string[]
          tenant_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_accounts_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_accounts_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      crm_activities: {
        Row: {
          account_id: string
          actor_label: string | null
          actor_user_id: string | null
          body: string | null
          contact_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          kind: Database["public"]["Enums"]["crm_activity_kind"]
          metadata: Json
          occurred_at: string
          title: string
        }
        Insert: {
          account_id: string
          actor_label?: string | null
          actor_user_id?: string | null
          body?: string | null
          contact_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["crm_activity_kind"]
          metadata?: Json
          occurred_at?: string
          title: string
        }
        Update: {
          account_id?: string
          actor_label?: string | null
          actor_user_id?: string | null
          body?: string | null
          contact_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["crm_activity_kind"]
          metadata?: Json
          occurred_at?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_activities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_activities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_appointments: {
        Row: {
          account_id: string
          booked_by_call_id: string | null
          contact_id: string | null
          created_at: string
          ends_at: string | null
          id: string
          journey_id: string | null
          kind: Database["public"]["Enums"]["crm_appointment_kind"]
          metadata: Json
          notes: string | null
          source: string
          starts_at: string
          status: Database["public"]["Enums"]["crm_appointment_status"]
          timezone: string
          title: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          booked_by_call_id?: string | null
          contact_id?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          journey_id?: string | null
          kind?: Database["public"]["Enums"]["crm_appointment_kind"]
          metadata?: Json
          notes?: string | null
          source?: string
          starts_at: string
          status?: Database["public"]["Enums"]["crm_appointment_status"]
          timezone?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          booked_by_call_id?: string | null
          contact_id?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          journey_id?: string | null
          kind?: Database["public"]["Enums"]["crm_appointment_kind"]
          metadata?: Json
          notes?: string | null
          source?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["crm_appointment_status"]
          timezone?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_appointments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_appointments_booked_by_call_id_fkey"
            columns: ["booked_by_call_id"]
            isOneToOne: false
            referencedRelation: "voice_calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_appointments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_appointments_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "crm_client_journeys"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_churn_events: {
        Row: {
          account_id: string
          competitor: string | null
          contract_id: string | null
          created_at: string
          data_retention_until: string | null
          effective_at: string | null
          final_invoice_id: string | null
          id: string
          metadata: Json
          purged_at: string | null
          reason: Database["public"]["Enums"]["crm_churn_reason"]
          reason_detail: string | null
          recorded_by: string | null
          refund_cents: number
          requested_at: string
          save_attempted: boolean
          save_outcome: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          competitor?: string | null
          contract_id?: string | null
          created_at?: string
          data_retention_until?: string | null
          effective_at?: string | null
          final_invoice_id?: string | null
          id?: string
          metadata?: Json
          purged_at?: string | null
          reason?: Database["public"]["Enums"]["crm_churn_reason"]
          reason_detail?: string | null
          recorded_by?: string | null
          refund_cents?: number
          requested_at?: string
          save_attempted?: boolean
          save_outcome?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          competitor?: string | null
          contract_id?: string | null
          created_at?: string
          data_retention_until?: string | null
          effective_at?: string | null
          final_invoice_id?: string | null
          id?: string
          metadata?: Json
          purged_at?: string | null
          reason?: Database["public"]["Enums"]["crm_churn_reason"]
          reason_detail?: string | null
          recorded_by?: string | null
          refund_cents?: number
          requested_at?: string
          save_attempted?: boolean
          save_outcome?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_churn_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_churn_events_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "crm_contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_client_journeys: {
        Row: {
          account_id: string
          calls_total: number
          contact_id: string
          created_at: string
          do_not_call: boolean
          entered_stage_at: string
          follow_up_at: string | null
          id: string
          last_call_at: string | null
          last_call_outcome: string | null
          metadata: Json
          notes: string | null
          stage_key: string
          updated_at: string
        }
        Insert: {
          account_id: string
          calls_total?: number
          contact_id: string
          created_at?: string
          do_not_call?: boolean
          entered_stage_at?: string
          follow_up_at?: string | null
          id?: string
          last_call_at?: string | null
          last_call_outcome?: string | null
          metadata?: Json
          notes?: string | null
          stage_key?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          calls_total?: number
          contact_id?: string
          created_at?: string
          do_not_call?: boolean
          entered_stage_at?: string
          follow_up_at?: string | null
          id?: string
          last_call_at?: string | null
          last_call_outcome?: string | null
          metadata?: Json
          notes?: string | null
          stage_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_client_journeys_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_client_journeys_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: true
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_client_journeys_stage_key_fkey"
            columns: ["stage_key"]
            isOneToOne: false
            referencedRelation: "crm_journey_stages"
            referencedColumns: ["key"]
          },
        ]
      }
      crm_contacts: {
        Row: {
          account_id: string
          created_at: string
          email: string | null
          first_name: string
          id: string
          is_primary: boolean
          job_title: string | null
          last_name: string | null
          marketing_consent: boolean
          metadata: Json
          notes: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          email?: string | null
          first_name: string
          id?: string
          is_primary?: boolean
          job_title?: string | null
          last_name?: string | null
          marketing_consent?: boolean
          metadata?: Json
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          email?: string | null
          first_name?: string
          id?: string
          is_primary?: boolean
          job_title?: string | null
          last_name?: string | null
          marketing_consent?: boolean
          metadata?: Json
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_contacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_contracts: {
        Row: {
          account_id: string
          auto_renew: boolean
          billing_cadence: string
          committed_seats: number
          created_at: string
          deal_id: string | null
          document_url: string | null
          id: string
          metadata: Json
          mrr_cents: number
          notice_period_days: number
          signed_at: string | null
          signed_by: string | null
          status: string
          term_end: string | null
          term_start: string
          terms_version_id: string | null
          tier_slug: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          auto_renew?: boolean
          billing_cadence?: string
          committed_seats?: number
          created_at?: string
          deal_id?: string | null
          document_url?: string | null
          id?: string
          metadata?: Json
          mrr_cents?: number
          notice_period_days?: number
          signed_at?: string | null
          signed_by?: string | null
          status?: string
          term_end?: string | null
          term_start?: string
          terms_version_id?: string | null
          tier_slug?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          auto_renew?: boolean
          billing_cadence?: string
          committed_seats?: number
          created_at?: string
          deal_id?: string | null
          document_url?: string | null
          id?: string
          metadata?: Json
          mrr_cents?: number
          notice_period_days?: number
          signed_at?: string | null
          signed_by?: string | null
          status?: string
          term_end?: string | null
          term_start?: string
          terms_version_id?: string | null
          tier_slug?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_contracts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_contracts_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "crm_deals"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_deal_line_items: {
        Row: {
          created_at: string
          deal_id: string
          id: string
          item_name: string
          item_slug: string | null
          kind: string
          quantity: number
          recurring: boolean
          unit_price_cents: number
        }
        Insert: {
          created_at?: string
          deal_id: string
          id?: string
          item_name: string
          item_slug?: string | null
          kind: string
          quantity?: number
          recurring?: boolean
          unit_price_cents?: number
        }
        Update: {
          created_at?: string
          deal_id?: string
          id?: string
          item_name?: string
          item_slug?: string | null
          kind?: string
          quantity?: number
          recurring?: boolean
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "crm_deal_line_items_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "crm_deals"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_deals: {
        Row: {
          account_id: string
          created_at: string
          expected_close_date: string | null
          expected_mrr_cents: number
          id: string
          lost_at: string | null
          lost_reason: string | null
          metadata: Json
          name: string
          owner_user_id: string | null
          probability: number
          seats: number
          setup_fee_cents: number
          stage: Database["public"]["Enums"]["crm_deal_stage"]
          stage_changed_at: string
          storefront_grant_id: string | null
          tier_slug: string | null
          updated_at: string
          won_at: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          expected_close_date?: string | null
          expected_mrr_cents?: number
          id?: string
          lost_at?: string | null
          lost_reason?: string | null
          metadata?: Json
          name: string
          owner_user_id?: string | null
          probability?: number
          seats?: number
          setup_fee_cents?: number
          stage?: Database["public"]["Enums"]["crm_deal_stage"]
          stage_changed_at?: string
          storefront_grant_id?: string | null
          tier_slug?: string | null
          updated_at?: string
          won_at?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          expected_close_date?: string | null
          expected_mrr_cents?: number
          id?: string
          lost_at?: string | null
          lost_reason?: string | null
          metadata?: Json
          name?: string
          owner_user_id?: string | null
          probability?: number
          seats?: number
          setup_fee_cents?: number
          stage?: Database["public"]["Enums"]["crm_deal_stage"]
          stage_changed_at?: string
          storefront_grant_id?: string | null
          tier_slug?: string | null
          updated_at?: string
          won_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_deals_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_disputes: {
        Row: {
          account_id: string | null
          amount_cents: number
          blocks_renewal: boolean
          closed_at: string | null
          created_at: string
          currency: string
          due_at: string | null
          evidence_url: string | null
          id: string
          kind: Database["public"]["Enums"]["crm_dispute_kind"]
          metadata: Json
          opened_at: string
          outcome: string | null
          owner_user_id: string | null
          reason: string | null
          status: Database["public"]["Enums"]["crm_dispute_status"]
          stripe_dispute_id: string | null
          stripe_payment_intent_id: string | null
          summary: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          amount_cents?: number
          blocks_renewal?: boolean
          closed_at?: string | null
          created_at?: string
          currency?: string
          due_at?: string | null
          evidence_url?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["crm_dispute_kind"]
          metadata?: Json
          opened_at?: string
          outcome?: string | null
          owner_user_id?: string | null
          reason?: string | null
          status?: Database["public"]["Enums"]["crm_dispute_status"]
          stripe_dispute_id?: string | null
          stripe_payment_intent_id?: string | null
          summary?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          amount_cents?: number
          blocks_renewal?: boolean
          closed_at?: string | null
          created_at?: string
          currency?: string
          due_at?: string | null
          evidence_url?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["crm_dispute_kind"]
          metadata?: Json
          opened_at?: string
          outcome?: string | null
          owner_user_id?: string | null
          reason?: string | null
          status?: Database["public"]["Enums"]["crm_dispute_status"]
          stripe_dispute_id?: string | null
          stripe_payment_intent_id?: string | null
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_disputes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_feedback_requests: {
        Row: {
          account_id: string
          campaign_key: string | null
          channel: string
          contact_id: string | null
          created_at: string
          id: string
          notes: string | null
          nps_score: number | null
          requested_at: string
          requested_by: string | null
          responded_at: string | null
          submission_id: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          campaign_key?: string | null
          channel?: string
          contact_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          nps_score?: number | null
          requested_at?: string
          requested_by?: string | null
          responded_at?: string | null
          submission_id?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          campaign_key?: string | null
          channel?: string
          contact_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          nps_score?: number | null
          requested_at?: string
          requested_by?: string | null
          responded_at?: string | null
          submission_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_feedback_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_feedback_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_fit_analyses: {
        Row: {
          account_id: string | null
          agreement: number | null
          completed_at: string | null
          confidence: number | null
          confidence_basis: Json
          correlation_map: Json
          coverage: number | null
          created_at: string
          error: string | null
          evidence_count: number | null
          grade: string | null
          headline: string | null
          id: string
          input_snapshot: Json
          integrity: Json
          knowledge_ids: string[]
          lead_id: string | null
          model: string | null
          open_questions: Json
          override_at: string | null
          override_by: string | null
          override_reason: string | null
          override_verdict:
            | Database["public"]["Enums"]["crm_fit_verdict"]
            | null
          raw_response: Json | null
          recommended_plan: Json
          requested_by: string | null
          research_summary: string | null
          risks: Json
          samples: number
          score: number | null
          status: Database["public"]["Enums"]["crm_fit_status"]
          subject_email: string | null
          subject_name: string
          subject_website: string | null
          tokens_used: number | null
          updated_at: string
          validation: Json
          verdict: Database["public"]["Enums"]["crm_fit_verdict"] | null
          verified_ratio: number | null
          version: number
        }
        Insert: {
          account_id?: string | null
          agreement?: number | null
          completed_at?: string | null
          confidence?: number | null
          confidence_basis?: Json
          correlation_map?: Json
          coverage?: number | null
          created_at?: string
          error?: string | null
          evidence_count?: number | null
          grade?: string | null
          headline?: string | null
          id?: string
          input_snapshot?: Json
          integrity?: Json
          knowledge_ids?: string[]
          lead_id?: string | null
          model?: string | null
          open_questions?: Json
          override_at?: string | null
          override_by?: string | null
          override_reason?: string | null
          override_verdict?:
            | Database["public"]["Enums"]["crm_fit_verdict"]
            | null
          raw_response?: Json | null
          recommended_plan?: Json
          requested_by?: string | null
          research_summary?: string | null
          risks?: Json
          samples?: number
          score?: number | null
          status?: Database["public"]["Enums"]["crm_fit_status"]
          subject_email?: string | null
          subject_name?: string
          subject_website?: string | null
          tokens_used?: number | null
          updated_at?: string
          validation?: Json
          verdict?: Database["public"]["Enums"]["crm_fit_verdict"] | null
          verified_ratio?: number | null
          version?: number
        }
        Update: {
          account_id?: string | null
          agreement?: number | null
          completed_at?: string | null
          confidence?: number | null
          confidence_basis?: Json
          correlation_map?: Json
          coverage?: number | null
          created_at?: string
          error?: string | null
          evidence_count?: number | null
          grade?: string | null
          headline?: string | null
          id?: string
          input_snapshot?: Json
          integrity?: Json
          knowledge_ids?: string[]
          lead_id?: string | null
          model?: string | null
          open_questions?: Json
          override_at?: string | null
          override_by?: string | null
          override_reason?: string | null
          override_verdict?:
            | Database["public"]["Enums"]["crm_fit_verdict"]
            | null
          raw_response?: Json | null
          recommended_plan?: Json
          requested_by?: string | null
          research_summary?: string | null
          risks?: Json
          samples?: number
          score?: number | null
          status?: Database["public"]["Enums"]["crm_fit_status"]
          subject_email?: string | null
          subject_name?: string
          subject_website?: string | null
          tokens_used?: number | null
          updated_at?: string
          validation?: Json
          verdict?: Database["public"]["Enums"]["crm_fit_verdict"] | null
          verified_ratio?: number | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "crm_fit_analyses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_fit_analyses_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "waitlist_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_fit_bands: {
        Row: {
          active: boolean
          created_at: string
          grade: string
          id: string
          label: string
          min_score: number
          sort_order: number
          updated_at: string
          verdict: Database["public"]["Enums"]["crm_fit_verdict"]
        }
        Insert: {
          active?: boolean
          created_at?: string
          grade: string
          id?: string
          label: string
          min_score: number
          sort_order?: number
          updated_at?: string
          verdict: Database["public"]["Enums"]["crm_fit_verdict"]
        }
        Update: {
          active?: boolean
          created_at?: string
          grade?: string
          id?: string
          label?: string
          min_score?: number
          sort_order?: number
          updated_at?: string
          verdict?: Database["public"]["Enums"]["crm_fit_verdict"]
        }
        Relationships: []
      }
      crm_fit_dimension_scores: {
        Row: {
          analysis_id: string
          answered: boolean
          capped: boolean
          created_at: string
          dimension: string
          evidence: Json
          id: string
          is_veto: boolean
          label: string
          rationale: string | null
          raw_score: number
          raw_spread: number | null
          sort_order: number
          verified: boolean
          weight: number
          weighted_score: number
        }
        Insert: {
          analysis_id: string
          answered?: boolean
          capped?: boolean
          created_at?: string
          dimension: string
          evidence?: Json
          id?: string
          is_veto?: boolean
          label: string
          rationale?: string | null
          raw_score?: number
          raw_spread?: number | null
          sort_order?: number
          verified?: boolean
          weight?: number
          weighted_score?: number
        }
        Update: {
          analysis_id?: string
          answered?: boolean
          capped?: boolean
          created_at?: string
          dimension?: string
          evidence?: Json
          id?: string
          is_veto?: boolean
          label?: string
          rationale?: string | null
          raw_score?: number
          raw_spread?: number | null
          sort_order?: number
          verified?: boolean
          weight?: number
          weighted_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "crm_fit_dimension_scores_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "crm_fit_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_fit_knowledge: {
        Row: {
          active: boolean
          content: string
          created_at: string
          file_name: string | null
          file_path: string | null
          id: string
          kind: Database["public"]["Enums"]["crm_fit_knowledge_kind"]
          mime_type: string | null
          pinned: boolean
          size_bytes: number | null
          summary: string | null
          tags: string[]
          title: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          active?: boolean
          content?: string
          created_at?: string
          file_name?: string | null
          file_path?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["crm_fit_knowledge_kind"]
          mime_type?: string | null
          pinned?: boolean
          size_bytes?: number | null
          summary?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          active?: boolean
          content?: string
          created_at?: string
          file_name?: string | null
          file_path?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["crm_fit_knowledge_kind"]
          mime_type?: string | null
          pinned?: boolean
          size_bytes?: number | null
          summary?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      crm_fit_rubric: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          dimension: string
          evidence_required: boolean
          id: string
          is_veto: boolean
          label: string
          sort_order: number
          unevidenced_ceiling: number
          updated_at: string
          veto_below: number | null
          weight: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          dimension: string
          evidence_required?: boolean
          id?: string
          is_veto?: boolean
          label: string
          sort_order?: number
          unevidenced_ceiling?: number
          updated_at?: string
          veto_below?: number | null
          weight?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          dimension?: string
          evidence_required?: boolean
          id?: string
          is_veto?: boolean
          label?: string
          sort_order?: number
          unevidenced_ceiling?: number
          updated_at?: string
          veto_below?: number | null
          weight?: number
        }
        Relationships: []
      }
      crm_journey_events: {
        Row: {
          actor_user_id: string | null
          call_id: string | null
          created_at: string
          from_stage: string | null
          id: string
          journey_id: string
          metadata: Json
          reason: string | null
          source: string
          to_stage: string | null
        }
        Insert: {
          actor_user_id?: string | null
          call_id?: string | null
          created_at?: string
          from_stage?: string | null
          id?: string
          journey_id: string
          metadata?: Json
          reason?: string | null
          source?: string
          to_stage?: string | null
        }
        Update: {
          actor_user_id?: string | null
          call_id?: string | null
          created_at?: string
          from_stage?: string | null
          id?: string
          journey_id?: string
          metadata?: Json
          reason?: string | null
          source?: string
          to_stage?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_journey_events_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "voice_calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_journey_events_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "crm_client_journeys"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_journey_stages: {
        Row: {
          color: string | null
          created_at: string
          id: string
          is_active: boolean
          is_terminal: boolean
          key: string
          name: string
          position: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_terminal?: boolean
          key: string
          name: string
          position?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_terminal?: boolean
          key?: string
          name?: string
          position?: number
          updated_at?: string
        }
        Relationships: []
      }
      crm_offboarding_runs: {
        Row: {
          account_id: string
          checklist: Json
          churn_event_id: string | null
          created_at: string
          destroy_after: string | null
          destroyed_at: string | null
          export_checksum: string | null
          export_delivered_at: string | null
          export_manifest: Json
          handoff_id: string | null
          id: string
          notes: string | null
          owner_user_id: string | null
          path: Database["public"]["Enums"]["crm_offboarding_path"]
          status: string
          updated_at: string
        }
        Insert: {
          account_id: string
          checklist?: Json
          churn_event_id?: string | null
          created_at?: string
          destroy_after?: string | null
          destroyed_at?: string | null
          export_checksum?: string | null
          export_delivered_at?: string | null
          export_manifest?: Json
          handoff_id?: string | null
          id?: string
          notes?: string | null
          owner_user_id?: string | null
          path?: Database["public"]["Enums"]["crm_offboarding_path"]
          status?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          checklist?: Json
          churn_event_id?: string | null
          created_at?: string
          destroy_after?: string | null
          destroyed_at?: string | null
          export_checksum?: string | null
          export_delivered_at?: string | null
          export_manifest?: Json
          handoff_id?: string | null
          id?: string
          notes?: string | null
          owner_user_id?: string | null
          path?: Database["public"]["Enums"]["crm_offboarding_path"]
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_offboarding_runs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_offboarding_runs_churn_event_id_fkey"
            columns: ["churn_event_id"]
            isOneToOne: false
            referencedRelation: "crm_churn_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_onboarding_tasks: {
        Row: {
          account_id: string
          auto_source: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          id: string
          label: string
          notes: string | null
          position: number
          status: string
          step_key: string
          updated_at: string
        }
        Insert: {
          account_id: string
          auto_source?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          label: string
          notes?: string | null
          position?: number
          status?: string
          step_key: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          auto_source?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          label?: string
          notes?: string | null
          position?: number
          status?: string
          step_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_onboarding_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_tasks: {
        Row: {
          account_id: string | null
          assignee_user_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          deal_id: string | null
          description: string | null
          due_at: string | null
          id: string
          metadata: Json
          status: Database["public"]["Enums"]["crm_task_status"]
          ticket_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          assignee_user_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deal_id?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          metadata?: Json
          status?: Database["public"]["Enums"]["crm_task_status"]
          ticket_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          assignee_user_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deal_id?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          metadata?: Json
          status?: Database["public"]["Enums"]["crm_task_status"]
          ticket_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_ticket_messages: {
        Row: {
          author_label: string | null
          author_user_id: string | null
          body: string
          created_at: string
          id: string
          internal: boolean
          ticket_id: string
        }
        Insert: {
          author_label?: string | null
          author_user_id?: string | null
          body: string
          created_at?: string
          id?: string
          internal?: boolean
          ticket_id: string
        }
        Update: {
          author_label?: string | null
          author_user_id?: string | null
          body?: string
          created_at?: string
          id?: string
          internal?: boolean
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_ticket_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "crm_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_tickets: {
        Row: {
          account_id: string
          assignee_user_id: string | null
          codex_finding_id: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          first_response_at: string | null
          id: string
          metadata: Json
          reference: string | null
          resolution: string | null
          resolved_at: string | null
          route_error_id: string | null
          severity: Database["public"]["Enums"]["crm_ticket_severity"]
          sla_due_at: string | null
          status: Database["public"]["Enums"]["crm_ticket_status"]
          subject: string
          type: Database["public"]["Enums"]["crm_ticket_type"]
          updated_at: string
        }
        Insert: {
          account_id: string
          assignee_user_id?: string | null
          codex_finding_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          first_response_at?: string | null
          id?: string
          metadata?: Json
          reference?: string | null
          resolution?: string | null
          resolved_at?: string | null
          route_error_id?: string | null
          severity?: Database["public"]["Enums"]["crm_ticket_severity"]
          sla_due_at?: string | null
          status?: Database["public"]["Enums"]["crm_ticket_status"]
          subject: string
          type?: Database["public"]["Enums"]["crm_ticket_type"]
          updated_at?: string
        }
        Update: {
          account_id?: string
          assignee_user_id?: string | null
          codex_finding_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          first_response_at?: string | null
          id?: string
          metadata?: Json
          reference?: string | null
          resolution?: string | null
          resolved_at?: string | null
          route_error_id?: string | null
          severity?: Database["public"]["Enums"]["crm_ticket_severity"]
          sla_due_at?: string | null
          status?: Database["public"]["Enums"]["crm_ticket_status"]
          subject?: string
          type?: Database["public"]["Enums"]["crm_ticket_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_tickets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_tickets_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      deployment_events: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string
          created_at: string
          error_message: string | null
          from_status: string | null
          id: string
          payload: Json
          provider_slug: string
          result: Json
          success: boolean
          to_status: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id: string
          created_at?: string
          error_message?: string | null
          from_status?: string | null
          id?: string
          payload?: Json
          provider_slug: string
          result?: Json
          success?: boolean
          to_status?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string
          created_at?: string
          error_message?: string | null
          from_status?: string | null
          id?: string
          payload?: Json
          provider_slug?: string
          result?: Json
          success?: boolean
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployment_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      docusign_connect_events: {
        Row: {
          agreement_id: string | null
          created_at: string
          decision: string
          docusign_status: string | null
          envelope_id: string
          error: string | null
          event_type: string
          hmac_valid: boolean
          id: string
          payload_summary: Json
        }
        Insert: {
          agreement_id?: string | null
          created_at?: string
          decision?: string
          docusign_status?: string | null
          envelope_id: string
          error?: string | null
          event_type: string
          hmac_valid?: boolean
          id?: string
          payload_summary?: Json
        }
        Update: {
          agreement_id?: string | null
          created_at?: string
          decision?: string
          docusign_status?: string | null
          envelope_id?: string
          error?: string | null
          event_type?: string
          hmac_valid?: boolean
          id?: string
          payload_summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "docusign_connect_events_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "client_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      edge_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string | null
          created_at: string
          error_message: string | null
          external_ref: string | null
          id: string
          payload: Json
          provider_slug: string
          result: Json
          success: boolean
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          external_ref?: string | null
          id?: string
          payload?: Json
          provider_slug: string
          result?: Json
          success: boolean
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          external_ref?: string | null
          id?: string
          payload?: Json
          provider_slug?: string
          result?: Json
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "edge_audit_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_audit_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      edge_dns_records: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          external_record_id: string
          id: string
          managed: boolean
          provider_slug: string
          proxied: boolean
          purpose: string
          record_content: string
          record_name: string
          record_type: string
          updated_at: string
          zone_id: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          external_record_id: string
          id?: string
          managed?: boolean
          provider_slug?: string
          proxied?: boolean
          purpose?: string
          record_content: string
          record_name: string
          record_type: string
          updated_at?: string
          zone_id: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          external_record_id?: string
          id?: string
          managed?: boolean
          provider_slug?: string
          proxied?: boolean
          purpose?: string
          record_content?: string
          record_name?: string
          record_type?: string
          updated_at?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edge_dns_records_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_dns_records_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      edge_posture_presets: {
        Row: {
          created_at: string
          description: string | null
          display_name: string
          is_default: boolean
          settings: Json
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_name: string
          is_default?: boolean
          settings?: Json
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_name?: string
          is_default?: boolean
          settings?: Json
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      edge_providers: {
        Row: {
          capabilities: Json
          created_at: string
          display_name: string
          slug: string
          sort_order: number
          status: string
          updated_at: string
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          display_name: string
          slug: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Update: {
          capabilities?: Json
          created_at?: string
          display_name?: string
          slug?: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      edge_provisioning_jobs: {
        Row: {
          action: string
          attempts: number
          clone_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          next_attempt_at: string
          payload: Json
          payload_hash: string
          provider_slug: string
          result: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          action: string
          attempts?: number
          clone_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          payload_hash: string
          provider_slug: string
          result?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          action?: string
          attempts?: number
          clone_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          payload_hash?: string
          provider_slug?: string
          result?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edge_provisioning_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_provisioning_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "edge_provisioning_jobs_provider_slug_fkey"
            columns: ["provider_slug"]
            isOneToOne: false
            referencedRelation: "edge_providers"
            referencedColumns: ["slug"]
          },
        ]
      }
      feedback_submissions: {
        Row: {
          additional_comments: string | null
          biggest_frustration: string | null
          campaign_key: string
          clone_id: string | null
          created_at: string
          feature_request: string | null
          forward_attempts: number
          forward_error: string | null
          forwarded_at: string | null
          id: string
          module_ratings: Json
          most_valuable: string | null
          next_forward_at: string
          origin_source: string | null
          origin_user_id: string | null
          origin_username: string | null
          overall_rating: number | null
          plan_name: string | null
          plan_slug: string | null
          recommend_score: number | null
          tenant_id: string
        }
        Insert: {
          additional_comments?: string | null
          biggest_frustration?: string | null
          campaign_key: string
          clone_id?: string | null
          created_at?: string
          feature_request?: string | null
          forward_attempts?: number
          forward_error?: string | null
          forwarded_at?: string | null
          id?: string
          module_ratings?: Json
          most_valuable?: string | null
          next_forward_at?: string
          origin_source?: string | null
          origin_user_id?: string | null
          origin_username?: string | null
          overall_rating?: number | null
          plan_name?: string | null
          plan_slug?: string | null
          recommend_score?: number | null
          tenant_id: string
        }
        Update: {
          additional_comments?: string | null
          biggest_frustration?: string | null
          campaign_key?: string
          clone_id?: string | null
          created_at?: string
          feature_request?: string | null
          forward_attempts?: number
          forward_error?: string | null
          forwarded_at?: string | null
          id?: string
          module_ratings?: Json
          most_valuable?: string | null
          next_forward_at?: string
          origin_source?: string | null
          origin_user_id?: string | null
          origin_username?: string | null
          overall_rating?: number | null
          plan_name?: string | null
          plan_slug?: string | null
          recommend_score?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_submissions_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_submissions_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "feedback_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_token_grants: {
        Row: {
          campaign_key: string
          created_at: string
          id: string
          ledger_id: string | null
          submission_id: string | null
          tenant_id: string
          tokens: number
        }
        Insert: {
          campaign_key: string
          created_at?: string
          id?: string
          ledger_id?: string | null
          submission_id?: string | null
          tenant_id: string
          tokens: number
        }
        Update: {
          campaign_key?: string
          created_at?: string
          id?: string
          ledger_id?: string | null
          submission_id?: string | null
          tenant_id?: string
          tokens?: number
        }
        Relationships: [
          {
            foreignKeyName: "feedback_token_grants_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "token_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_token_grants_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "feedback_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_token_grants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      fleet_digests: {
        Row: {
          created_at: string
          generated_by_model: string | null
          id: string
          metrics: Json
          period_end: string
          period_start: string
          summary_markdown: string
        }
        Insert: {
          created_at?: string
          generated_by_model?: string | null
          id?: string
          metrics?: Json
          period_end: string
          period_start: string
          summary_markdown: string
        }
        Update: {
          created_at?: string
          generated_by_model?: string | null
          id?: string
          metrics?: Json
          period_end?: string
          period_start?: string
          summary_markdown?: string
        }
        Relationships: []
      }
      github_secret_syncs: {
        Row: {
          clone_id: string | null
          created_at: string
          failed: Json
          id: string
          ok: boolean
          owner: string
          repo: string
          skipped: Json
          target_kind: string
          trigger_source: string
          triggered_by: string | null
          written: string[]
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          failed?: Json
          id?: string
          ok: boolean
          owner: string
          repo: string
          skipped?: Json
          target_kind: string
          trigger_source?: string
          triggered_by?: string | null
          written?: string[]
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          failed?: Json
          id?: string
          ok?: boolean
          owner?: string
          repo?: string
          skipped?: Json
          target_kind?: string
          trigger_source?: string
          triggered_by?: string | null
          written?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "github_secret_syncs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_secret_syncs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      handoff_audit_events: {
        Row: {
          action: string | null
          actor: string | null
          handoff_id: string
          id: string
          occurred_at: string | null
          payload: Json
          received_at: string
          source_event_id: string
          source_project_ref: string | null
          source_table: string | null
        }
        Insert: {
          action?: string | null
          actor?: string | null
          handoff_id: string
          id?: string
          occurred_at?: string | null
          payload?: Json
          received_at?: string
          source_event_id: string
          source_project_ref?: string | null
          source_table?: string | null
        }
        Update: {
          action?: string | null
          actor?: string | null
          handoff_id?: string
          id?: string
          occurred_at?: string | null
          payload?: Json
          received_at?: string
          source_event_id?: string
          source_project_ref?: string | null
          source_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_audit_events_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_audit_shippers: {
        Row: {
          created_at: string
          enabled: boolean
          endpoint_url: string
          filter: Json
          handoff_id: string
          hmac_secret: string
          id: string
          last_error: string | null
          last_event_at: string | null
          last_shipped_at: string | null
          total_shipped: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          endpoint_url: string
          filter?: Json
          handoff_id: string
          hmac_secret: string
          id?: string
          last_error?: string | null
          last_event_at?: string | null
          last_shipped_at?: string | null
          total_shipped?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          endpoint_url?: string
          filter?: Json
          handoff_id?: string
          hmac_secret?: string
          id?: string
          last_error?: string | null
          last_event_at?: string | null
          last_shipped_at?: string | null
          total_shipped?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_audit_shippers_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: true
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_billing_splits: {
        Row: {
          aurixa_products_kept: Json
          aurixa_stripe_customer_id: string | null
          aurixa_stripe_subscription_id: string | null
          client_billed_directly: boolean
          client_supabase_org_id: string | null
          client_supabase_plan: string | null
          clone_id: string
          created_at: string
          created_by: string | null
          decoupled_at: string | null
          disclosed_to_client_at: string | null
          handoff_id: string
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          aurixa_products_kept?: Json
          aurixa_stripe_customer_id?: string | null
          aurixa_stripe_subscription_id?: string | null
          client_billed_directly?: boolean
          client_supabase_org_id?: string | null
          client_supabase_plan?: string | null
          clone_id: string
          created_at?: string
          created_by?: string | null
          decoupled_at?: string | null
          disclosed_to_client_at?: string | null
          handoff_id: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          aurixa_products_kept?: Json
          aurixa_stripe_customer_id?: string | null
          aurixa_stripe_subscription_id?: string | null
          client_billed_directly?: boolean
          client_supabase_org_id?: string | null
          client_supabase_plan?: string | null
          clone_id?: string
          created_at?: string
          created_by?: string | null
          decoupled_at?: string | null
          disclosed_to_client_at?: string | null
          handoff_id?: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_billing_splits_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handoff_billing_splits_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "handoff_billing_splits_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: true
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_contracts: {
        Row: {
          created_at: string
          document_storage_path: string | null
          handoff_id: string
          id: string
          ip_address: string | null
          metadata: Json
          pdf_storage_path: string | null
          signature_bundle_sha256: string | null
          signed_at: string | null
          signed_by_email: string | null
          signed_by_name: string | null
          snapshot_manifest: Json
          terms_hash: string
          terms_version_id: string | null
          user_agent: string | null
          version: string
        }
        Insert: {
          created_at?: string
          document_storage_path?: string | null
          handoff_id: string
          id?: string
          ip_address?: string | null
          metadata?: Json
          pdf_storage_path?: string | null
          signature_bundle_sha256?: string | null
          signed_at?: string | null
          signed_by_email?: string | null
          signed_by_name?: string | null
          snapshot_manifest?: Json
          terms_hash: string
          terms_version_id?: string | null
          user_agent?: string | null
          version: string
        }
        Update: {
          created_at?: string
          document_storage_path?: string | null
          handoff_id?: string
          id?: string
          ip_address?: string | null
          metadata?: Json
          pdf_storage_path?: string | null
          signature_bundle_sha256?: string | null
          signed_at?: string | null
          signed_by_email?: string | null
          signed_by_name?: string | null
          snapshot_manifest?: Json
          terms_hash?: string
          terms_version_id?: string | null
          user_agent?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_contracts_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handoff_contracts_terms_version_id_fkey"
            columns: ["terms_version_id"]
            isOneToOne: false
            referencedRelation: "handoff_terms_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_cost_exports: {
        Row: {
          error: string | null
          generated_at: string
          handoff_id: string
          id: string
          period_end: string
          period_start: string
          rows_included: number | null
          status: string
          storage_path: string | null
          total_cents: number | null
          total_tokens: number | null
        }
        Insert: {
          error?: string | null
          generated_at?: string
          handoff_id: string
          id?: string
          period_end: string
          period_start: string
          rows_included?: number | null
          status?: string
          storage_path?: string | null
          total_cents?: number | null
          total_tokens?: number | null
        }
        Update: {
          error?: string | null
          generated_at?: string
          handoff_id?: string
          id?: string
          period_end?: string
          period_start?: string
          rows_included?: number | null
          status?: string
          storage_path?: string | null
          total_cents?: number | null
          total_tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_cost_exports_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          details: Json
          handoff_id: string
          id: string
          kind: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          handoff_id: string
          id?: string
          kind: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          handoff_id?: string
          id?: string
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_events_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_invites: {
        Row: {
          consumed_at: string | null
          consumed_ip: string | null
          created_at: string
          created_by: string | null
          expires_at: string
          handoff_id: string
          id: string
          plan_allowlist: string[]
          region_allowlist: string[]
          revoked_at: string | null
          revoked_reason: string | null
          terms_body: string | null
          terms_hash: string
          terms_version: string
          token_hash: string
          token_prefix: string
          updated_at: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_ip?: string | null
          created_at?: string
          created_by?: string | null
          expires_at: string
          handoff_id: string
          id?: string
          plan_allowlist?: string[]
          region_allowlist?: string[]
          revoked_at?: string | null
          revoked_reason?: string | null
          terms_body?: string | null
          terms_hash: string
          terms_version: string
          token_hash: string
          token_prefix: string
          updated_at?: string
        }
        Update: {
          consumed_at?: string | null
          consumed_ip?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          handoff_id?: string
          id?: string
          plan_allowlist?: string[]
          region_allowlist?: string[]
          revoked_at?: string | null
          revoked_reason?: string | null
          terms_body?: string | null
          terms_hash?: string
          terms_version?: string
          token_hash?: string
          token_prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_invites_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_observability_configs: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          handoff_id: string
          id: string
          last_error: string | null
          last_poll_at: string | null
          last_snapshot: Json
          last_status: string | null
          mode: string
          next_poll_at: string | null
          notes: string | null
          poll_interval_seconds: number
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          handoff_id: string
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          last_snapshot?: Json
          last_status?: string | null
          mode?: string
          next_poll_at?: string | null
          notes?: string | null
          poll_interval_seconds?: number
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          handoff_id?: string
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          last_snapshot?: Json
          last_status?: string | null
          mode?: string
          next_poll_at?: string | null
          notes?: string | null
          poll_interval_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_observability_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handoff_observability_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "handoff_observability_configs_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: true
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_parity_reports: {
        Row: {
          auth_diff: Json
          blocking_issues: Json
          buckets_diff: Json
          cron_diff: Json
          edge_functions_diff: Json
          extensions_diff: Json
          functions_diff: Json
          generated_at: string
          handoff_id: string
          id: string
          policies_diff: Json
          prime_ref: string | null
          risk_level: string
          secrets_diff: Json
          summary: string | null
          tables_diff: Json
          target_ref: string | null
        }
        Insert: {
          auth_diff?: Json
          blocking_issues?: Json
          buckets_diff?: Json
          cron_diff?: Json
          edge_functions_diff?: Json
          extensions_diff?: Json
          functions_diff?: Json
          generated_at?: string
          handoff_id: string
          id?: string
          policies_diff?: Json
          prime_ref?: string | null
          risk_level?: string
          secrets_diff?: Json
          summary?: string | null
          tables_diff?: Json
          target_ref?: string | null
        }
        Update: {
          auth_diff?: Json
          blocking_issues?: Json
          buckets_diff?: Json
          cron_diff?: Json
          edge_functions_diff?: Json
          extensions_diff?: Json
          functions_diff?: Json
          generated_at?: string
          handoff_id?: string
          id?: string
          policies_diff?: Json
          prime_ref?: string | null
          risk_level?: string
          secrets_diff?: Json
          summary?: string | null
          tables_diff?: Json
          target_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_parity_reports_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_region_plan_policies: {
        Row: {
          allowed_plans: string[]
          allowed_regions: string[]
          created_at: string
          id: string
          is_active: boolean
          min_plan: string | null
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          allowed_plans?: string[]
          allowed_regions?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          min_plan?: string | null
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          allowed_plans?: string[]
          allowed_regions?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          min_plan?: string | null
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      handoff_secret_rotations: {
        Row: {
          created_at: string
          error: string | null
          handoff_id: string
          id: string
          key_ref: string
          metadata: Json
          rotated_at: string | null
          status: string
          target: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          handoff_id: string
          id?: string
          key_ref: string
          metadata?: Json
          rotated_at?: string | null
          status?: string
          target: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          handoff_id?: string
          id?: string
          key_ref?: string
          metadata?: Json
          rotated_at?: string | null
          status?: string
          target?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_secret_rotations_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_snapshots: {
        Row: {
          created_at: string
          error: string | null
          handoff_id: string
          id: string
          kind: string
          metadata: Json
          retention_expires_at: string | null
          sha256: string | null
          size_bytes: number | null
          status: string
          storage_path: string | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          handoff_id: string
          id?: string
          kind: string
          metadata?: Json
          retention_expires_at?: string | null
          sha256?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
        }
        Update: {
          created_at?: string
          error?: string | null
          handoff_id?: string
          id?: string
          kind?: string
          metadata?: Json
          retention_expires_at?: string | null
          sha256?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_snapshots_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_storage_replications: {
        Row: {
          bucket_id: string
          bytes_copied: number
          completed_at: string | null
          created_at: string
          cursor_offset: number
          cursor_prefix: string | null
          handoff_id: string
          id: string
          last_error: string | null
          last_run_at: string | null
          objects_copied: number
          objects_failed: number
          objects_scanned: number
          objects_skipped: number
          status: string
          updated_at: string
        }
        Insert: {
          bucket_id: string
          bytes_copied?: number
          completed_at?: string | null
          created_at?: string
          cursor_offset?: number
          cursor_prefix?: string | null
          handoff_id: string
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          objects_copied?: number
          objects_failed?: number
          objects_scanned?: number
          objects_skipped?: number
          status?: string
          updated_at?: string
        }
        Update: {
          bucket_id?: string
          bytes_copied?: number
          completed_at?: string | null
          created_at?: string
          cursor_offset?: number
          cursor_prefix?: string | null
          handoff_id?: string
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          objects_copied?: number
          objects_failed?: number
          objects_scanned?: number
          objects_skipped?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_storage_replications_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_terms_versions: {
        Row: {
          body_md: string
          created_at: string
          created_by: string | null
          effective_at: string | null
          id: string
          is_active: boolean
          metadata: Json
          retired_at: string | null
          terms_hash: string
          title: string
          updated_at: string
          version: string
        }
        Insert: {
          body_md: string
          created_at?: string
          created_by?: string | null
          effective_at?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          retired_at?: string | null
          terms_hash: string
          title: string
          updated_at?: string
          version: string
        }
        Update: {
          body_md?: string
          created_at?: string
          created_by?: string | null
          effective_at?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          retired_at?: string | null
          terms_hash?: string
          title?: string
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      hosting_providers: {
        Row: {
          capabilities: Json
          created_at: string
          display_name: string
          slug: string
          sort_order: number
          status: string
          updated_at: string
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          display_name: string
          slug: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Update: {
          capabilities?: Json
          created_at?: string
          display_name?: string
          slug?: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      hosting_teardowns: {
        Row: {
          attempts: number
          clone_id: string | null
          clone_name: string | null
          clone_slug: string | null
          completed_at: string | null
          created_at: string
          dns_record_ids: string[]
          domain: string | null
          error_message: string | null
          id: string
          max_attempts: number
          next_attempt_at: string
          project_id: string | null
          project_name: string | null
          provider_slug: string
          requested_by: string | null
          result: Json
          status: string
          team_id: string | null
          worker_started_at: string | null
          zone_id: string | null
        }
        Insert: {
          attempts?: number
          clone_id?: string | null
          clone_name?: string | null
          clone_slug?: string | null
          completed_at?: string | null
          created_at?: string
          dns_record_ids?: string[]
          domain?: string | null
          error_message?: string | null
          id?: string
          max_attempts?: number
          next_attempt_at?: string
          project_id?: string | null
          project_name?: string | null
          provider_slug?: string
          requested_by?: string | null
          result?: Json
          status?: string
          team_id?: string | null
          worker_started_at?: string | null
          zone_id?: string | null
        }
        Update: {
          attempts?: number
          clone_id?: string | null
          clone_name?: string | null
          clone_slug?: string | null
          completed_at?: string | null
          created_at?: string
          dns_record_ids?: string[]
          domain?: string | null
          error_message?: string | null
          id?: string
          max_attempts?: number
          next_attempt_at?: string
          project_id?: string | null
          project_name?: string | null
          provider_slug?: string
          requested_by?: string | null
          result?: Json
          status?: string
          team_id?: string | null
          worker_started_at?: string | null
          zone_id?: string | null
        }
        Relationships: []
      }
      invoices: {
        Row: {
          amount_due_cents: number | null
          amount_paid_cents: number | null
          amount_remaining_cents: number | null
          clone_id: string | null
          created_at: string
          currency: string | null
          description: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_pdf_url: string | null
          issued_at: string | null
          item_name: string | null
          item_slug: string | null
          metadata: Json
          mode: string | null
          number: string | null
          origin_source: string | null
          origin_user_id: string | null
          origin_username: string | null
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          purchase_id: string | null
          status: string | null
          stripe_customer_id: string | null
          stripe_invoice_id: string
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          subtotal_cents: number | null
          tax_cents: number | null
          tenant_id: string | null
          total_cents: number | null
          updated_at: string
        }
        Insert: {
          amount_due_cents?: number | null
          amount_paid_cents?: number | null
          amount_remaining_cents?: number | null
          clone_id?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_pdf_url?: string | null
          issued_at?: string | null
          item_name?: string | null
          item_slug?: string | null
          metadata?: Json
          mode?: string | null
          number?: string | null
          origin_source?: string | null
          origin_user_id?: string | null
          origin_username?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          purchase_id?: string | null
          status?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_id: string
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          subtotal_cents?: number | null
          tax_cents?: number | null
          tenant_id?: string | null
          total_cents?: number | null
          updated_at?: string
        }
        Update: {
          amount_due_cents?: number | null
          amount_paid_cents?: number | null
          amount_remaining_cents?: number | null
          clone_id?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_pdf_url?: string | null
          issued_at?: string | null
          item_name?: string | null
          item_slug?: string | null
          metadata?: Json
          mode?: string | null
          number?: string | null
          origin_source?: string | null
          origin_user_id?: string | null
          origin_username?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          purchase_id?: string | null
          status?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_id?: string
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          subtotal_cents?: number | null
          tax_cents?: number | null
          tenant_id?: string | null
          total_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "invoices_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      migration_assertion_checks: {
        Row: {
          assertion: string
          checked_at: string
          detail: string
          first_seen_at: string
          kind: string
          last_satisfied_at: string | null
          migration: string
          status: string
        }
        Insert: {
          assertion: string
          checked_at?: string
          detail: string
          first_seen_at?: string
          kind: string
          last_satisfied_at?: string | null
          migration: string
          status: string
        }
        Update: {
          assertion?: string
          checked_at?: string
          detail?: string
          first_seen_at?: string
          kind?: string
          last_satisfied_at?: string | null
          migration?: string
          status?: string
        }
        Relationships: []
      }
      module_backend_artifacts: {
        Row: {
          artifact_kind: string
          confidence: string
          created_at: string
          detection_run_id: string | null
          file_path: string | null
          id: string
          identifier: string
          link_reason: string | null
          metadata: Json
          module_id: string | null
          module_slug: string
          shared_with_modules: string[]
        }
        Insert: {
          artifact_kind: string
          confidence?: string
          created_at?: string
          detection_run_id?: string | null
          file_path?: string | null
          id?: string
          identifier: string
          link_reason?: string | null
          metadata?: Json
          module_id?: string | null
          module_slug: string
          shared_with_modules?: string[]
        }
        Update: {
          artifact_kind?: string
          confidence?: string
          created_at?: string
          detection_run_id?: string | null
          file_path?: string | null
          id?: string
          identifier?: string
          link_reason?: string | null
          metadata?: Json
          module_id?: string | null
          module_slug?: string
          shared_with_modules?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "module_backend_artifacts_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "module_backend_artifacts_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      module_cascade_jobs: {
        Row: {
          cascade_event_id: string | null
          clone_ids: string[]
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          initiated_by: string | null
          metadata: Json
          module_ids: string[]
          status: string
          updated_at: string
        }
        Insert: {
          cascade_event_id?: string | null
          clone_ids?: string[]
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          initiated_by?: string | null
          metadata?: Json
          module_ids?: string[]
          status?: string
          updated_at?: string
        }
        Update: {
          cascade_event_id?: string | null
          clone_ids?: string[]
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          initiated_by?: string | null
          metadata?: Json
          module_ids?: string[]
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      module_config_snapshots: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          label: string
          module_ids: string[]
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          label?: string
          module_ids?: string[]
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          label?: string
          module_ids?: string[]
        }
        Relationships: []
      }
      module_detection_runs: {
        Row: {
          backend_module_count: number
          backend_summary: Json
          completed_at: string | null
          created_at: string
          database_object_count: number
          delta_mode: boolean | null
          dependency_count: number | null
          edge_function_count: number
          error_message: string | null
          file_count: number | null
          id: string
          initiated_by: string | null
          inserted_modules: number | null
          migration_count: number
          orphan_files_found: number | null
          parameters: Json | null
          pass_count: number | null
          passes: Json | null
          previous_run_id: string | null
          proposed_modules: number | null
          sampled_file_count: number | null
          secret_count: number
          started_at: string | null
          status: string
          strategy: string
          tree_hash: string | null
          updated_at: string
          updated_modules: number | null
        }
        Insert: {
          backend_module_count?: number
          backend_summary?: Json
          completed_at?: string | null
          created_at?: string
          database_object_count?: number
          delta_mode?: boolean | null
          dependency_count?: number | null
          edge_function_count?: number
          error_message?: string | null
          file_count?: number | null
          id?: string
          initiated_by?: string | null
          inserted_modules?: number | null
          migration_count?: number
          orphan_files_found?: number | null
          parameters?: Json | null
          pass_count?: number | null
          passes?: Json | null
          previous_run_id?: string | null
          proposed_modules?: number | null
          sampled_file_count?: number | null
          secret_count?: number
          started_at?: string | null
          status?: string
          strategy?: string
          tree_hash?: string | null
          updated_at?: string
          updated_modules?: number | null
        }
        Update: {
          backend_module_count?: number
          backend_summary?: Json
          completed_at?: string | null
          created_at?: string
          database_object_count?: number
          delta_mode?: boolean | null
          dependency_count?: number | null
          edge_function_count?: number
          error_message?: string | null
          file_count?: number | null
          id?: string
          initiated_by?: string | null
          inserted_modules?: number | null
          migration_count?: number
          orphan_files_found?: number | null
          parameters?: Json | null
          pass_count?: number | null
          passes?: Json | null
          previous_run_id?: string | null
          proposed_modules?: number | null
          sampled_file_count?: number | null
          secret_count?: number
          started_at?: string | null
          status?: string
          strategy?: string
          tree_hash?: string | null
          updated_at?: string
          updated_modules?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "module_detection_runs_previous_run_id_fkey"
            columns: ["previous_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      module_drift_alerts: {
        Row: {
          alert_type: string
          created_at: string
          detection_run_id: string | null
          file_path: string | null
          id: string
          module_id: string | null
          reasoning: string | null
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          suggested_module_slug: string | null
        }
        Insert: {
          alert_type: string
          created_at?: string
          detection_run_id?: string | null
          file_path?: string | null
          id?: string
          module_id?: string | null
          reasoning?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          suggested_module_slug?: string | null
        }
        Update: {
          alert_type?: string
          created_at?: string
          detection_run_id?: string | null
          file_path?: string | null
          id?: string
          module_id?: string | null
          reasoning?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          suggested_module_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "module_drift_alerts_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "module_drift_alerts_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      module_import_edges: {
        Row: {
          created_at: string
          detection_run_id: string
          id: string
          import_type: string
          source_file: string
          target_file: string
        }
        Insert: {
          created_at?: string
          detection_run_id: string
          id?: string
          import_type?: string
          source_file: string
          target_file: string
        }
        Update: {
          created_at?: string
          detection_run_id?: string
          id?: string
          import_type?: string
          source_file?: string
          target_file?: string
        }
        Relationships: [
          {
            foreignKeyName: "module_import_edges_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      module_library: {
        Row: {
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          created_at: string
          deprecated_at: string | null
          deprecated_reason: string | null
          description: string | null
          entry_file: string
          file_count: number
          file_paths: string[]
          id: string
          is_latest: boolean
          metadata: Json
          name: string
          published_at: string
          published_by: string | null
          rejection_reason: string | null
          replacement_slug: string | null
          route_path: string | null
          slug: string
          source_detection_run_id: string | null
          source_module_id: string | null
          tags: string[]
          updated_at: string
          version: number
        }
        Insert: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          deprecated_at?: string | null
          deprecated_reason?: string | null
          description?: string | null
          entry_file: string
          file_count?: number
          file_paths?: string[]
          id?: string
          is_latest?: boolean
          metadata?: Json
          name: string
          published_at?: string
          published_by?: string | null
          rejection_reason?: string | null
          replacement_slug?: string | null
          route_path?: string | null
          slug: string
          source_detection_run_id?: string | null
          source_module_id?: string | null
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Update: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          deprecated_at?: string | null
          deprecated_reason?: string | null
          description?: string | null
          entry_file?: string
          file_count?: number
          file_paths?: string[]
          id?: string
          is_latest?: boolean
          metadata?: Json
          name?: string
          published_at?: string
          published_by?: string | null
          rejection_reason?: string | null
          replacement_slug?: string | null
          route_path?: string | null
          slug?: string
          source_detection_run_id?: string | null
          source_module_id?: string | null
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      modules: {
        Row: {
          ai_confidence: number | null
          ai_reasoning: string | null
          apply_on_install: boolean
          approved_at: string | null
          approved_by: string | null
          backend_file_globs: string[]
          backend_manifest: Json
          clone_migration_sql: string | null
          cohesion_score: number | null
          coupling_score: number | null
          created_at: string
          cron_jobs: string[]
          database_rpcs: string[]
          database_tables: string[]
          dependencies: string[]
          description: string | null
          detected_by_ai: boolean
          detection_run_id: string | null
          edge_functions: string[]
          external_hosts: string[]
          file_globs: string[]
          id: string
          incompatible_with: string[]
          layer: string
          name: string
          orphan_file_count: number | null
          rejection_reason: string | null
          required_migrations: string[]
          required_secrets: string[]
          requires: string[]
          resolved_files: string[]
          route_entry_file: string | null
          routes: string[]
          shared_by_modules: string[]
          slug: string
          status: Database["public"]["Enums"]["module_status"]
          storage_buckets: string[]
          tree_snapshot_hash: string | null
          updated_at: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          apply_on_install?: boolean
          approved_at?: string | null
          approved_by?: string | null
          backend_file_globs?: string[]
          backend_manifest?: Json
          clone_migration_sql?: string | null
          cohesion_score?: number | null
          coupling_score?: number | null
          created_at?: string
          cron_jobs?: string[]
          database_rpcs?: string[]
          database_tables?: string[]
          dependencies?: string[]
          description?: string | null
          detected_by_ai?: boolean
          detection_run_id?: string | null
          edge_functions?: string[]
          external_hosts?: string[]
          file_globs?: string[]
          id?: string
          incompatible_with?: string[]
          layer?: string
          name: string
          orphan_file_count?: number | null
          rejection_reason?: string | null
          required_migrations?: string[]
          required_secrets?: string[]
          requires?: string[]
          resolved_files?: string[]
          route_entry_file?: string | null
          routes?: string[]
          shared_by_modules?: string[]
          slug: string
          status?: Database["public"]["Enums"]["module_status"]
          storage_buckets?: string[]
          tree_snapshot_hash?: string | null
          updated_at?: string
        }
        Update: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          apply_on_install?: boolean
          approved_at?: string | null
          approved_by?: string | null
          backend_file_globs?: string[]
          backend_manifest?: Json
          clone_migration_sql?: string | null
          cohesion_score?: number | null
          coupling_score?: number | null
          created_at?: string
          cron_jobs?: string[]
          database_rpcs?: string[]
          database_tables?: string[]
          dependencies?: string[]
          description?: string | null
          detected_by_ai?: boolean
          detection_run_id?: string | null
          edge_functions?: string[]
          external_hosts?: string[]
          file_globs?: string[]
          id?: string
          incompatible_with?: string[]
          layer?: string
          name?: string
          orphan_file_count?: number | null
          rejection_reason?: string | null
          required_migrations?: string[]
          required_secrets?: string[]
          requires?: string[]
          resolved_files?: string[]
          route_entry_file?: string | null
          routes?: string[]
          shared_by_modules?: string[]
          slug?: string
          status?: Database["public"]["Enums"]["module_status"]
          storage_buckets?: string[]
          tree_snapshot_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "modules_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string
          digest_mode: string
          id: string
          mute_browser_push: boolean
          mute_toasts: boolean
          muted_kinds: Database["public"]["Enums"]["notification_kind"][]
          muted_severities: Database["public"]["Enums"]["notification_severity"][]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          digest_mode?: string
          id?: string
          mute_browser_push?: boolean
          mute_toasts?: boolean
          muted_kinds?: Database["public"]["Enums"]["notification_kind"][]
          muted_severities?: Database["public"]["Enums"]["notification_severity"][]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          digest_mode?: string
          id?: string
          mute_browser_push?: boolean
          mute_toasts?: boolean
          muted_kinds?: Database["public"]["Enums"]["notification_kind"][]
          muted_severities?: Database["public"]["Enums"]["notification_severity"][]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          cascade_event_id: string | null
          clone_id: string | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["notification_kind"]
          metadata: Json
          read_at: string | null
          severity: Database["public"]["Enums"]["notification_severity"]
          title: string
          url: string | null
        }
        Insert: {
          body?: string | null
          cascade_event_id?: string | null
          clone_id?: string | null
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["notification_kind"]
          metadata?: Json
          read_at?: string | null
          severity?: Database["public"]["Enums"]["notification_severity"]
          title: string
          url?: string | null
        }
        Update: {
          body?: string | null
          cascade_event_id?: string | null
          clone_id?: string | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["notification_kind"]
          metadata?: Json
          read_at?: string | null
          severity?: Database["public"]["Enums"]["notification_severity"]
          title?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      payment_methods: {
        Row: {
          billing_email: string | null
          billing_name: string | null
          brand: string | null
          card_fingerprint: string | null
          clone_id: string | null
          created_at: string
          detached_at: string | null
          exp_month: number | null
          exp_year: number | null
          funding: string | null
          id: string
          last4: string | null
          metadata: Json
          origin_source: string
          origin_user_id: string | null
          origin_username: string | null
          priority: number
          status: string
          stripe_checkout_session_id: string | null
          stripe_customer_id: string
          stripe_payment_method_id: string
          stripe_setup_intent_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          billing_email?: string | null
          billing_name?: string | null
          brand?: string | null
          card_fingerprint?: string | null
          clone_id?: string | null
          created_at?: string
          detached_at?: string | null
          exp_month?: number | null
          exp_year?: number | null
          funding?: string | null
          id?: string
          last4?: string | null
          metadata?: Json
          origin_source?: string
          origin_user_id?: string | null
          origin_username?: string | null
          priority: number
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_customer_id: string
          stripe_payment_method_id: string
          stripe_setup_intent_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          billing_email?: string | null
          billing_name?: string | null
          brand?: string | null
          card_fingerprint?: string | null
          clone_id?: string | null
          created_at?: string
          detached_at?: string | null
          exp_month?: number | null
          exp_year?: number | null
          funding?: string | null
          id?: string
          last4?: string | null
          metadata?: Json
          origin_source?: string
          origin_user_id?: string | null
          origin_username?: string | null
          priority?: number
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string
          stripe_payment_method_id?: string
          stripe_setup_intent_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_methods_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_methods_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "payment_methods_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_calls: {
        Row: {
          account_id: string | null
          answered_at: string | null
          contact_id: string | null
          created_at: string
          customer_name: string | null
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          metadata: Json
          notes: string | null
          operator_identity: string | null
          operator_user_id: string | null
          parent_call_sid: string | null
          phone_number: string
          recording_duration_seconds: number | null
          recording_sid: string | null
          recording_url: string | null
          started_at: string
          status: string
          twilio_call_sid: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          answered_at?: string | null
          contact_id?: string | null
          created_at?: string
          customer_name?: string | null
          direction: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          operator_identity?: string | null
          operator_user_id?: string | null
          parent_call_sid?: string | null
          phone_number: string
          recording_duration_seconds?: number | null
          recording_sid?: string | null
          recording_url?: string | null
          started_at?: string
          status?: string
          twilio_call_sid?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          answered_at?: string | null
          contact_id?: string | null
          created_at?: string
          customer_name?: string | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          operator_identity?: string | null
          operator_user_id?: string | null
          parent_call_sid?: string | null
          phone_number?: string
          recording_duration_seconds?: number | null
          recording_sid?: string | null
          recording_url?: string | null
          started_at?: string
          status?: string
          twilio_call_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_calls_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phone_calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_change_events: {
        Row: {
          acknowledged_at: string | null
          created_at: string
          credits_expire_at: string | null
          credits_granted: number
          from_plan_name: string | null
          from_plan_slug: string | null
          id: string
          modules_reconciled_at: string | null
          reconciliation_id: string | null
          source_ref: string
          tenant_id: string
          to_plan_name: string
          to_plan_slug: string
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string
          credits_expire_at?: string | null
          credits_granted?: number
          from_plan_name?: string | null
          from_plan_slug?: string | null
          id?: string
          modules_reconciled_at?: string | null
          reconciliation_id?: string | null
          source_ref: string
          tenant_id: string
          to_plan_name: string
          to_plan_slug: string
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string
          credits_expire_at?: string | null
          credits_granted?: number
          from_plan_name?: string | null
          from_plan_slug?: string | null
          id?: string
          modules_reconciled_at?: string | null
          reconciliation_id?: string | null
          source_ref?: string
          tenant_id?: string
          to_plan_name?: string
          to_plan_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_change_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_module_entitlements: {
        Row: {
          created_at: string
          enabled: boolean
          entitlement_key: string
          id: string
          module_name: string
          note: string | null
          plan_slug: string
          sub_module_name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          entitlement_key: string
          id?: string
          module_name: string
          note?: string | null
          plan_slug: string
          sub_module_name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          entitlement_key?: string
          id?: string
          module_name?: string
          note?: string | null
          plan_slug?: string
          sub_module_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_hosting_config: {
        Row: {
          auto_deploy: boolean
          auto_provision: boolean
          cloudflare_account_id: string | null
          cloudflare_zone_id: string | null
          cloudflare_zone_name: string | null
          created_at: string
          hosting_provider_slug: string
          id: string
          primary_domain: string
          provider_slug: string
          proxied: boolean
          reserved_slugs: string[]
          singleton: boolean
          subdomain_pattern: string
          target_type: string
          target_value: string
          updated_at: string
          updated_by: string | null
          vercel_project_prefix: string
          vercel_team_id: string | null
        }
        Insert: {
          auto_deploy?: boolean
          auto_provision?: boolean
          cloudflare_account_id?: string | null
          cloudflare_zone_id?: string | null
          cloudflare_zone_name?: string | null
          created_at?: string
          hosting_provider_slug?: string
          id?: string
          primary_domain?: string
          provider_slug?: string
          proxied?: boolean
          reserved_slugs?: string[]
          singleton?: boolean
          subdomain_pattern?: string
          target_type?: string
          target_value?: string
          updated_at?: string
          updated_by?: string | null
          vercel_project_prefix?: string
          vercel_team_id?: string | null
        }
        Update: {
          auto_deploy?: boolean
          auto_provision?: boolean
          cloudflare_account_id?: string | null
          cloudflare_zone_id?: string | null
          cloudflare_zone_name?: string | null
          created_at?: string
          hosting_provider_slug?: string
          id?: string
          primary_domain?: string
          provider_slug?: string
          proxied?: boolean
          reserved_slugs?: string[]
          singleton?: boolean
          subdomain_pattern?: string
          target_type?: string
          target_value?: string
          updated_at?: string
          updated_by?: string | null
          vercel_project_prefix?: string
          vercel_team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_hosting_config_hosting_provider_fk"
            columns: ["hosting_provider_slug"]
            isOneToOne: false
            referencedRelation: "hosting_providers"
            referencedColumns: ["slug"]
          },
        ]
      }
      pricing_module_map: {
        Row: {
          confidence: string
          created_at: string
          entitlement_key: string | null
          id: string
          is_override: boolean
          mapping_kind: string
          module_slugs: string[]
          overridden_at: string | null
          overridden_by: string | null
          reason: string | null
          source_kind: string
          source_name: string
          source_slug: string
          updated_at: string
        }
        Insert: {
          confidence?: string
          created_at?: string
          entitlement_key?: string | null
          id?: string
          is_override?: boolean
          mapping_kind?: string
          module_slugs?: string[]
          overridden_at?: string | null
          overridden_by?: string | null
          reason?: string | null
          source_kind: string
          source_name: string
          source_slug: string
          updated_at?: string
        }
        Update: {
          confidence?: string
          created_at?: string
          entitlement_key?: string | null
          id?: string
          is_override?: boolean
          mapping_kind?: string
          module_slugs?: string[]
          overridden_at?: string | null
          overridden_by?: string | null
          reason?: string | null
          source_kind?: string
          source_name?: string
          source_slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      prime_config: {
        Row: {
          codex_nightly_cron: string
          codex_nightly_enabled: boolean
          codex_post_merge_revalidate: boolean
          codex_pr_scan_enabled: boolean
          clone_gate_default_hours: number
          clone_gate_enabled: boolean
          codex_scan_dedup_hours: number
          created_at: string
          default_branch: string
          default_cascade_mode: Database["public"]["Enums"]["cascade_mode"]
          default_clone_org: string | null
          github_app_installation_id: string | null
          github_owner: string
          github_repo: string
          id: string
          notes: string | null
          supabase_project_ref: string | null
          updated_at: string
        }
        Insert: {
          codex_nightly_cron?: string
          codex_nightly_enabled?: boolean
          codex_post_merge_revalidate?: boolean
          codex_pr_scan_enabled?: boolean
          clone_gate_default_hours?: number
          clone_gate_enabled?: boolean
          codex_scan_dedup_hours?: number
          created_at?: string
          default_branch?: string
          default_cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          default_clone_org?: string | null
          github_app_installation_id?: string | null
          github_owner: string
          github_repo: string
          id?: string
          notes?: string | null
          supabase_project_ref?: string | null
          updated_at?: string
        }
        Update: {
          codex_nightly_cron?: string
          codex_nightly_enabled?: boolean
          codex_post_merge_revalidate?: boolean
          codex_pr_scan_enabled?: boolean
          clone_gate_default_hours?: number
          clone_gate_enabled?: boolean
          codex_scan_dedup_hours?: number
          created_at?: string
          default_branch?: string
          default_cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          default_clone_org?: string | null
          github_app_installation_id?: string | null
          github_owner?: string
          github_repo?: string
          id?: string
          notes?: string | null
          supabase_project_ref?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      prime_secret_forwards: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          inherit: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          inherit?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          inherit?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      prime_snapshot_scans: {
        Row: {
          declared_function_slugs: Json
          git_sha: string
          repo: string
          scanned_at: string
          secret_names: Json
        }
        Insert: {
          declared_function_slugs: Json
          git_sha: string
          repo: string
          scanned_at?: string
          secret_names: Json
        }
        Update: {
          declared_function_slugs?: Json
          git_sha?: string
          repo?: string
          scanned_at?: string
          secret_names?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      purchases: {
        Row: {
          amount_cents: number | null
          clone_id: string | null
          completed_at: string | null
          created_at: string
          currency: string | null
          handoff_id: string | null
          id: string
          item_id: string | null
          item_name: string | null
          item_slug: string | null
          metadata: Json
          mode: string
          origin_source: string
          origin_user_id: string | null
          origin_username: string | null
          payment_status: string | null
          quantity: number
          status: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents?: number | null
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string | null
          handoff_id?: string | null
          id?: string
          item_id?: string | null
          item_name?: string | null
          item_slug?: string | null
          metadata?: Json
          mode: string
          origin_source?: string
          origin_user_id?: string | null
          origin_username?: string | null
          payment_status?: string | null
          quantity?: number
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number | null
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string | null
          handoff_id?: string | null
          id?: string
          item_id?: string | null
          item_name?: string | null
          item_slug?: string | null
          metadata?: Json
          mode?: string
          origin_source?: string
          origin_user_id?: string | null
          origin_username?: string | null
          payment_status?: string | null
          quantity?: number
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchases_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "purchases_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "billing_handoffs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      push_delivery_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          notification_id: string | null
          status_code: number | null
          subscription_id: string | null
          success: boolean
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          notification_id?: string | null
          status_code?: number | null
          subscription_id?: string | null
          success: boolean
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          notification_id?: string | null
          status_code?: number | null
          subscription_id?: string | null
          success?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      remediation_runs: {
        Row: {
          action_type: Database["public"]["Enums"]["remediation_action_type"]
          approved_at: string | null
          approved_by: string | null
          attempts: number
          clone_id: string | null
          completed_at: string | null
          created_at: string
          destructive: boolean
          finding_id: string | null
          id: string
          last_error: string | null
          max_attempts: number
          next_attempt_at: string
          plan: Json
          policy: Json
          priority: Database["public"]["Enums"]["ticket_priority"]
          rejected_at: string | null
          rejected_by: string | null
          rejected_reason: string | null
          remediation_id: string | null
          requires_human: boolean
          result: Json
          started_at: string | null
          status: Database["public"]["Enums"]["remediation_run_status"]
          ticket_id: string | null
          updated_at: string
        }
        Insert: {
          action_type: Database["public"]["Enums"]["remediation_action_type"]
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          destructive?: boolean
          finding_id?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          next_attempt_at?: string
          plan?: Json
          policy?: Json
          priority?: Database["public"]["Enums"]["ticket_priority"]
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_reason?: string | null
          remediation_id?: string | null
          requires_human?: boolean
          result?: Json
          started_at?: string | null
          status?: Database["public"]["Enums"]["remediation_run_status"]
          ticket_id?: string | null
          updated_at?: string
        }
        Update: {
          action_type?: Database["public"]["Enums"]["remediation_action_type"]
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          destructive?: boolean
          finding_id?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          next_attempt_at?: string
          plan?: Json
          policy?: Json
          priority?: Database["public"]["Enums"]["ticket_priority"]
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_reason?: string | null
          remediation_id?: string | null
          requires_human?: boolean
          result?: Json
          started_at?: string | null
          status?: Database["public"]["Enums"]["remediation_run_status"]
          ticket_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "remediation_runs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remediation_runs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "remediation_runs_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "codex_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remediation_runs_remediation_id_fkey"
            columns: ["remediation_id"]
            isOneToOne: false
            referencedRelation: "codex_remediations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remediation_runs_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      repo_blob_analysis: {
        Row: {
          analysis: Json
          blob_sha: string
          byte_size: number | null
          created_at: string
          kind: string
          last_seen_at: string
          path: string
        }
        Insert: {
          analysis: Json
          blob_sha: string
          byte_size?: number | null
          created_at?: string
          kind: string
          last_seen_at?: string
          path: string
        }
        Update: {
          analysis?: Json
          blob_sha?: string
          byte_size?: number | null
          created_at?: string
          kind?: string
          last_seen_at?: string
          path?: string
        }
        Relationships: []
      }
      report_cost_revisions: {
        Row: {
          cascade_result: Json
          changes: Json
          costs: Json
          created_at: string
          id: string
          note: string | null
          published_by: string | null
          version: number
        }
        Insert: {
          cascade_result?: Json
          changes?: Json
          costs?: Json
          created_at?: string
          id?: string
          note?: string | null
          published_by?: string | null
          version?: never
        }
        Update: {
          cascade_result?: Json
          changes?: Json
          costs?: Json
          created_at?: string
          id?: string
          note?: string | null
          published_by?: string | null
          version?: never
        }
        Relationships: []
      }
      report_credit_costs: {
        Row: {
          category: string
          created_at: string
          credit_cost: number
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          credit_cost?: number
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          credit_cost?: number
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      report_jobs: {
        Row: {
          charged_tokens: number
          clone_id: string | null
          completed_at: string | null
          created_at: string
          error: string | null
          estimated_tokens: number
          id: string
          idempotency_key: string
          kind: string
          request_payload: Json
          reservation_expires_at: string | null
          result_meta: Json
          started_at: string
          status: Database["public"]["Enums"]["report_job_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          charged_tokens?: number
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          estimated_tokens?: number
          id?: string
          idempotency_key: string
          kind: string
          request_payload?: Json
          reservation_expires_at?: string | null
          result_meta?: Json
          started_at?: string
          status?: Database["public"]["Enums"]["report_job_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          charged_tokens?: number
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          estimated_tokens?: number
          id?: string
          idempotency_key?: string
          kind?: string
          request_payload?: Json
          reservation_expires_at?: string | null
          result_meta?: Json
          started_at?: string
          status?: Database["public"]["Enums"]["report_job_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "report_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      route_errors: {
        Row: {
          created_at: string
          id: string
          message: string
          metadata: Json | null
          route_path: string
          stack: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          metadata?: Json | null
          route_path: string
          stack?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          metadata?: Json | null
          route_path?: string
          stack?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      schema_migration_queue: {
        Row: {
          attempts: number
          enqueued_at: string
          enqueued_by: string | null
          error: string | null
          finished_at: string | null
          id: string
          name: string
          sha256: string | null
          sql: string
          started_at: string | null
          status: string
          version: string
        }
        Insert: {
          attempts?: number
          enqueued_at?: string
          enqueued_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          name: string
          sha256?: string | null
          sql: string
          started_at?: string | null
          status?: string
          version: string
        }
        Update: {
          attempts?: number
          enqueued_at?: string
          enqueued_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          name?: string
          sha256?: string | null
          sql?: string
          started_at?: string | null
          status?: string
          version?: string
        }
        Relationships: []
      }
      seat_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string | null
          created_at: string
          external_user_id: string | null
          id: string
          metadata: Json
          seat_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          external_user_id?: string | null
          id?: string
          metadata?: Json
          seat_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          external_user_id?: string | null
          id?: string
          metadata?: Json
          seat_id?: string | null
        }
        Relationships: []
      }
      seat_plans: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          device_limit_per_seat: number | null
          id: string
          is_active: boolean
          is_default: boolean
          metadata: Json
          name: string
          overage_policy: string
          price_cents: number
          seat_limit: number
          slug: string
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          device_limit_per_seat?: number | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          metadata?: Json
          name: string
          overage_policy?: string
          price_cents?: number
          seat_limit: number
          slug: string
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          device_limit_per_seat?: number | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          metadata?: Json
          name?: string
          overage_policy?: string
          price_cents?: number
          seat_limit?: number
          slug?: string
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      seat_roles: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          permissions: Json
          price_max_cents: number
          price_min_cents: number
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          permissions?: Json
          price_max_cents?: number
          price_min_cents?: number
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          permissions?: Json
          price_max_cents?: number
          price_min_cents?: number
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      security_assessment_comments: {
        Row: {
          assessment_id: string
          author_kind: string
          author_user_id: string | null
          body: string
          clone_id: string
          created_at: string
          id: string
          metadata: Json
          partner_id: string
          visibility: string
        }
        Insert: {
          assessment_id: string
          author_kind: string
          author_user_id?: string | null
          body: string
          clone_id: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id: string
          visibility?: string
        }
        Update: {
          assessment_id?: string
          author_kind?: string
          author_user_id?: string | null
          body?: string
          clone_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_assessment_comments_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_comments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_comments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_assessment_comments_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_assessment_events: {
        Row: {
          actor_kind: string
          actor_user_id: string | null
          assessment_id: string | null
          body: string | null
          clone_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          partner_id: string | null
        }
        Insert: {
          actor_kind?: string
          actor_user_id?: string | null
          assessment_id?: string | null
          body?: string | null
          clone_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          partner_id?: string | null
        }
        Update: {
          actor_kind?: string
          actor_user_id?: string | null
          assessment_id?: string | null
          body?: string | null
          clone_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          partner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_assessment_events_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_assessment_events_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_assessments: {
        Row: {
          assignment_id: string | null
          aurixa_review_status: string
          client_release_approved: boolean
          clone_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          cycle: string
          due_at: string | null
          emergency_stop_contact: string | null
          escalation_contacts: Json
          exclusions: string | null
          id: string
          partner_id: string
          remediation_owner: string | null
          retest_required: boolean
          rules_of_engagement: string | null
          scope_summary: string | null
          started_at: string | null
          status: string
          target_urls: string[]
          testing_window_end: string | null
          testing_window_start: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assignment_id?: string | null
          aurixa_review_status?: string
          client_release_approved?: boolean
          clone_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          cycle?: string
          due_at?: string | null
          emergency_stop_contact?: string | null
          escalation_contacts?: Json
          exclusions?: string | null
          id?: string
          partner_id: string
          remediation_owner?: string | null
          retest_required?: boolean
          rules_of_engagement?: string | null
          scope_summary?: string | null
          started_at?: string | null
          status?: string
          target_urls?: string[]
          testing_window_end?: string | null
          testing_window_start?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assignment_id?: string | null
          aurixa_review_status?: string
          client_release_approved?: boolean
          clone_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          cycle?: string
          due_at?: string | null
          emergency_stop_contact?: string | null
          escalation_contacts?: Json
          exclusions?: string | null
          id?: string
          partner_id?: string
          remediation_owner?: string | null
          retest_required?: boolean
          rules_of_engagement?: string | null
          scope_summary?: string | null
          started_at?: string | null
          status?: string
          target_urls?: string[]
          testing_window_end?: string | null
          testing_window_start?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_assessments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "security_partner_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_assessments_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_external_tickets: {
        Row: {
          codex_finding_id: string | null
          created_at: string
          created_by: string | null
          external_id: string
          id: string
          metadata: Json
          provider: string
          source_slug: string
          status: string
          updated_at: string
          url: string | null
        }
        Insert: {
          codex_finding_id?: string | null
          created_at?: string
          created_by?: string | null
          external_id: string
          id?: string
          metadata?: Json
          provider: string
          source_slug: string
          status?: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          codex_finding_id?: string | null
          created_at?: string
          created_by?: string | null
          external_id?: string
          id?: string
          metadata?: Json
          provider?: string
          source_slug?: string
          status?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_external_tickets_codex_finding_id_fkey"
            columns: ["codex_finding_id"]
            isOneToOne: false
            referencedRelation: "codex_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_external_tickets_source_slug_fkey"
            columns: ["source_slug"]
            isOneToOne: false
            referencedRelation: "security_intake_sources"
            referencedColumns: ["slug"]
          },
        ]
      }
      security_findings: {
        Row: {
          affected_asset: string | null
          assessment_id: string
          clone_id: string
          codex_finding_id: string | null
          created_at: string
          cvss: string | null
          cwe: string | null
          description: string | null
          evidence: string | null
          id: string
          partner_id: string
          recommendation: string | null
          remediation_pr_url: string | null
          resolved_at: string | null
          retest_status: string
          severity: string
          source: string
          status: string
          submitted_by: string | null
          title: string
          updated_at: string
        }
        Insert: {
          affected_asset?: string | null
          assessment_id: string
          clone_id: string
          codex_finding_id?: string | null
          created_at?: string
          cvss?: string | null
          cwe?: string | null
          description?: string | null
          evidence?: string | null
          id?: string
          partner_id: string
          recommendation?: string | null
          remediation_pr_url?: string | null
          resolved_at?: string | null
          retest_status?: string
          severity?: string
          source?: string
          status?: string
          submitted_by?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          affected_asset?: string | null
          assessment_id?: string
          clone_id?: string
          codex_finding_id?: string | null
          created_at?: string
          cvss?: string | null
          cwe?: string | null
          description?: string | null
          evidence?: string | null
          id?: string
          partner_id?: string
          recommendation?: string | null
          remediation_pr_url?: string | null
          resolved_at?: string | null
          retest_status?: string
          severity?: string
          source?: string
          status?: string
          submitted_by?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_findings_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_findings_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_findings_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_findings_codex_finding_id_fkey"
            columns: ["codex_finding_id"]
            isOneToOne: false
            referencedRelation: "codex_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_findings_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_intake_sources: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          hmac_secret: string | null
          id: string
          kind: string
          metadata: Json
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          hmac_secret?: string | null
          id?: string
          kind: string
          metadata?: Json
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          hmac_secret?: string | null
          id?: string
          kind?: string
          metadata?: Json
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      security_partner_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          clone_id: string
          created_at: string
          id: string
          metadata: Json
          partner_id: string
          revoked_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          clone_id: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          clone_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id?: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_partner_assignments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_partner_assignments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_partner_assignments_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_partner_memberships: {
        Row: {
          accepted_at: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          last_seen_at: string | null
          partner_id: string
          role: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id?: string
          last_seen_at?: string | null
          partner_id: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          last_seen_at?: string | null
          partner_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_partner_memberships_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_partners: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          metadata: Json
          name: string
          notes: string | null
          primary_contact_email: string | null
          primary_contact_name: string | null
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          name: string
          notes?: string | null
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          name?: string
          notes?: string | null
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      security_reports: {
        Row: {
          assessment_id: string
          clone_id: string
          created_at: string
          file_path: string | null
          file_url: string | null
          id: string
          label: string
          notes: string | null
          partner_id: string
          report_type: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          assessment_id: string
          clone_id: string
          created_at?: string
          file_path?: string | null
          file_url?: string | null
          id?: string
          label: string
          notes?: string | null
          partner_id: string
          report_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          assessment_id?: string
          clone_id?: string
          created_at?: string
          file_path?: string | null
          file_url?: string | null
          id?: string
          label?: string
          notes?: string | null
          partner_id?: string
          report_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_reports_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_reports_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_reports_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_reports_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      setup_packages: {
        Row: {
          applies_to_plans: string[]
          created_at: string
          currency: string
          deliverables: Json
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          price_max_cents: number
          price_min_cents: number
          slug: string
          sort_order: number
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          applies_to_plans?: string[]
          created_at?: string
          currency?: string
          deliverables?: Json
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          price_max_cents?: number
          price_min_cents?: number
          slug: string
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          applies_to_plans?: string[]
          created_at?: string
          currency?: string
          deliverables?: Json
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          price_max_cents?: number
          price_min_cents?: number
          slug?: string
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      setup_purchases: {
        Row: {
          amount_cents: number | null
          created_at: string
          currency: string | null
          fulfilled_at: string | null
          id: string
          metadata: Json
          refund_amount_cents: number | null
          refunded_at: string | null
          setup_package_id: string | null
          status: string
          stripe_charge_id: string | null
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents?: number | null
          created_at?: string
          currency?: string | null
          fulfilled_at?: string | null
          id?: string
          metadata?: Json
          refund_amount_cents?: number | null
          refunded_at?: string | null
          setup_package_id?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number | null
          created_at?: string
          currency?: string | null
          fulfilled_at?: string | null
          id?: string
          metadata?: Json
          refund_amount_cents?: number | null
          refunded_at?: string | null
          setup_package_id?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "setup_purchases_setup_package_id_fkey"
            columns: ["setup_package_id"]
            isOneToOne: false
            referencedRelation: "setup_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "setup_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      storefront_access_grants: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          label: string
          last_used_at: string | null
          note: string | null
          revoked_at: string | null
          updated_at: string
          use_count: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          label: string
          last_used_at?: string | null
          note?: string | null
          revoked_at?: string | null
          updated_at?: string
          use_count?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          label?: string
          last_used_at?: string | null
          note?: string | null
          revoked_at?: string | null
          updated_at?: string
          use_count?: number
        }
        Relationships: []
      }
      stripe_events: {
        Row: {
          clone_id: string | null
          created_at: string
          error: string | null
          id: string
          payload: Json
          processed_at: string | null
          stripe_account_id: string | null
          stripe_event_id: string
          type: string
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          payload: Json
          processed_at?: string | null
          stripe_account_id?: string | null
          stripe_event_id: string
          type: string
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          payload?: Json
          processed_at?: string | null
          stripe_account_id?: string | null
          stripe_event_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      support_assistant_activity: {
        Row: {
          asked_at: string | null
          clone_id: string | null
          created_at: string
          escalate_reason: string | null
          escalated: boolean
          id: string
          latency_ms: number | null
          mode: string
          question: string
          source: string | null
          tenant_id: string | null
          user_external_id: string | null
          verified_source: boolean
          workspace_id: string | null
        }
        Insert: {
          asked_at?: string | null
          clone_id?: string | null
          created_at?: string
          escalate_reason?: string | null
          escalated?: boolean
          id?: string
          latency_ms?: number | null
          mode: string
          question: string
          source?: string | null
          tenant_id?: string | null
          user_external_id?: string | null
          verified_source?: boolean
          workspace_id?: string | null
        }
        Update: {
          asked_at?: string | null
          clone_id?: string | null
          created_at?: string
          escalate_reason?: string | null
          escalated?: boolean
          id?: string
          latency_ms?: number | null
          mode?: string
          question?: string
          source?: string | null
          tenant_id?: string | null
          user_external_id?: string | null
          verified_source?: boolean
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "support_assistant_activity_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_assistant_activity_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "support_assistant_activity_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_ingest_requests: {
        Row: {
          created_at: string
          id: string
          ip_hash: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip_hash: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip_hash?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      support_ticket_events: {
        Row: {
          actor: string
          created_at: string
          event_type: string
          id: string
          payload: Json
          ticket_id: string
        }
        Insert: {
          actor?: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          ticket_id: string
        }
        Update: {
          actor?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_ticket_events_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          auto_remediable: boolean
          breakage_vector: Database["public"]["Enums"]["support_breakage_vector"]
          category: Database["public"]["Enums"]["support_ticket_category"]
          classification: Json
          client_meta: Json
          clone_id: string | null
          codex_finding_id: string | null
          created_at: string
          description: string
          first_response_at: string | null
          id: string
          impact: string | null
          metadata: Json
          priority: Database["public"]["Enums"]["ticket_priority"]
          priority_overridden_at: string | null
          priority_overridden_by: string | null
          priority_score: number
          reference: string
          remediation_lane: string | null
          reporter_email: string | null
          reporter_name: string | null
          requires_human: boolean
          resolution: string | null
          resolved_at: string | null
          sla_breached_at: string | null
          sla_due_at: string | null
          source_slug: string
          status: Database["public"]["Enums"]["support_ticket_status"]
          subject: string
          tenant_id: string | null
          updated_at: string
          user_external_id: string | null
          workspace_id: string
        }
        Insert: {
          auto_remediable?: boolean
          breakage_vector?: Database["public"]["Enums"]["support_breakage_vector"]
          category: Database["public"]["Enums"]["support_ticket_category"]
          classification?: Json
          client_meta?: Json
          clone_id?: string | null
          codex_finding_id?: string | null
          created_at?: string
          description: string
          first_response_at?: string | null
          id?: string
          impact?: string | null
          metadata?: Json
          priority: Database["public"]["Enums"]["ticket_priority"]
          priority_overridden_at?: string | null
          priority_overridden_by?: string | null
          priority_score?: number
          reference: string
          remediation_lane?: string | null
          reporter_email?: string | null
          reporter_name?: string | null
          requires_human?: boolean
          resolution?: string | null
          resolved_at?: string | null
          sla_breached_at?: string | null
          sla_due_at?: string | null
          source_slug?: string
          status?: Database["public"]["Enums"]["support_ticket_status"]
          subject: string
          tenant_id?: string | null
          updated_at?: string
          user_external_id?: string | null
          workspace_id: string
        }
        Update: {
          auto_remediable?: boolean
          breakage_vector?: Database["public"]["Enums"]["support_breakage_vector"]
          category?: Database["public"]["Enums"]["support_ticket_category"]
          classification?: Json
          client_meta?: Json
          clone_id?: string | null
          codex_finding_id?: string | null
          created_at?: string
          description?: string
          first_response_at?: string | null
          id?: string
          impact?: string | null
          metadata?: Json
          priority?: Database["public"]["Enums"]["ticket_priority"]
          priority_overridden_at?: string | null
          priority_overridden_by?: string | null
          priority_score?: number
          reference?: string
          remediation_lane?: string | null
          reporter_email?: string | null
          reporter_name?: string | null
          requires_human?: boolean
          resolution?: string | null
          resolved_at?: string | null
          sla_breached_at?: string | null
          sla_due_at?: string | null
          source_slug?: string
          status?: Database["public"]["Enums"]["support_ticket_status"]
          subject?: string
          tenant_id?: string | null
          updated_at?: string
          user_external_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "support_tickets_codex_finding_id_fkey"
            columns: ["codex_finding_id"]
            isOneToOne: false
            referencedRelation: "codex_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_source_slug_fkey"
            columns: ["source_slug"]
            isOneToOne: false
            referencedRelation: "security_intake_sources"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "support_tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telephony_registrations: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          identity: string
          last_seen_at: string
          ring_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          identity: string
          last_seen_at?: string
          ring_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          identity?: string
          last_seen_at?: string
          ring_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tenants: {
        Row: {
          billing_exempt: boolean
          billing_stripe_customer_id: string | null
          billing_user_id: string | null
          clone_id: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          display_name: string | null
          external_ref: string
          id: string
          metadata: Json
          plan_id: string | null
          plan_started_at: string | null
          status: Database["public"]["Enums"]["tenant_status"]
          stripe_customer_id: string | null
          tax_id_business_name: string | null
          tax_id_captured_at: string | null
          tax_id_type: string | null
          tax_id_value: string | null
          updated_at: string
        }
        Insert: {
          billing_exempt?: boolean
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          display_name?: string | null
          external_ref: string
          id?: string
          metadata?: Json
          plan_id?: string | null
          plan_started_at?: string | null
          status?: Database["public"]["Enums"]["tenant_status"]
          stripe_customer_id?: string | null
          tax_id_business_name?: string | null
          tax_id_captured_at?: string | null
          tax_id_type?: string | null
          tax_id_value?: string | null
          updated_at?: string
        }
        Update: {
          billing_exempt?: boolean
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          display_name?: string | null
          external_ref?: string
          id?: string
          metadata?: Json
          plan_id?: string | null
          plan_started_at?: string | null
          status?: Database["public"]["Enums"]["tenant_status"]
          stripe_customer_id?: string | null
          tax_id_business_name?: string | null
          tax_id_captured_at?: string | null
          tax_id_type?: string | null
          tax_id_value?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenants_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "tenants_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      token_api_rate_limits: {
        Row: {
          count: number
          key_id: string
          window_start: string
        }
        Insert: {
          count?: number
          key_id: string
          window_start: string
        }
        Update: {
          count?: number
          key_id?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_api_rate_limits_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "clone_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      token_balances: {
        Row: {
          available: number
          lifetime_granted: number
          lifetime_spent: number
          reserved: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          available?: number
          lifetime_granted?: number
          lifetime_spent?: number
          reserved?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          available?: number
          lifetime_granted?: number
          lifetime_spent?: number
          reserved?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_balances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      token_ledger: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          kind: Database["public"]["Enums"]["ledger_kind"]
          metadata: Json
          reason: string | null
          report_job_id: string | null
          source: Database["public"]["Enums"]["ledger_source"]
          source_ref: string | null
          tenant_id: string
          tokens: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["ledger_kind"]
          metadata?: Json
          reason?: string | null
          report_job_id?: string | null
          source: Database["public"]["Enums"]["ledger_source"]
          source_ref?: string | null
          tenant_id: string
          tokens: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["ledger_kind"]
          metadata?: Json
          reason?: string | null
          report_job_id?: string | null
          source?: Database["public"]["Enums"]["ledger_source"]
          source_ref?: string | null
          tenant_id?: string
          tokens?: number
        }
        Relationships: [
          {
            foreignKeyName: "token_ledger_report_job_id_fkey"
            columns: ["report_job_id"]
            isOneToOne: false
            referencedRelation: "report_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      token_rates: {
        Row: {
          base_cost: number
          created_at: string
          effective_from: string
          id: string
          kind: string
          notes: string | null
          per_unit: Json
          updated_at: string
        }
        Insert: {
          base_cost?: number
          created_at?: string
          effective_from?: string
          id?: string
          kind: string
          notes?: string | null
          per_unit?: Json
          updated_at?: string
        }
        Update: {
          base_cost?: number
          created_at?: string
          effective_from?: string
          id?: string
          kind?: string
          notes?: string | null
          per_unit?: Json
          updated_at?: string
        }
        Relationships: []
      }
      token_webhook_deliveries: {
        Row: {
          attempts: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          event_type: string
          id: string
          next_attempt_at: string | null
          payload: Json
          response_body: string | null
          response_code: number | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          event_type: string
          id?: string
          next_attempt_at?: string | null
          payload?: Json
          response_body?: string | null
          response_code?: number | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          event_type?: string
          id?: string
          next_attempt_at?: string | null
          payload?: Json
          response_body?: string | null
          response_code?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_webhook_deliveries_endpoint_id_fkey"
            columns: ["endpoint_id"]
            isOneToOne: false
            referencedRelation: "token_webhook_endpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      token_webhook_endpoints: {
        Row: {
          clone_id: string | null
          created_at: string
          created_by: string | null
          events: string[]
          id: string
          is_active: boolean
          secret: string
          updated_at: string
          url: string
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          secret: string
          updated_at?: string
          url: string
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          secret?: string
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      topup_packs: {
        Row: {
          created_at: string
          currency: string
          expires_after_days: number | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          price_cents: number
          slug: string
          stripe_price_id: string | null
          tokens: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          expires_after_days?: number | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          price_cents: number
          slug: string
          stripe_price_id?: string | null
          tokens: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          expires_after_days?: number | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          price_cents?: number
          slug?: string
          stripe_price_id?: string | null
          tokens?: number
          updated_at?: string
        }
        Relationships: []
      }
      user_invites: {
        Row: {
          accepted_at: string | null
          accepted_user_id: string | null
          created_at: string
          email: string | null
          expires_at: string
          id: string
          invited_by: string
          note: string | null
          revoked_at: string | null
          revoked_by: string | null
          role: Database["public"]["Enums"]["app_role"]
          token_hash: string
          token_prefix: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_user_id?: string | null
          created_at?: string
          email?: string | null
          expires_at: string
          id?: string
          invited_by: string
          note?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token_hash: string
          token_prefix: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_user_id?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          invited_by?: string
          note?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token_hash?: string
          token_prefix?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          created_at: string
          id: string
          name: string
          payload: Json
          scope: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          payload?: Json
          scope: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          payload?: Json
          scope?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      voice_agents: {
        Row: {
          config: Json
          created_at: string
          description: string | null
          direction: string
          id: string
          is_active: boolean
          metadata: Json
          name: string
          role: string | null
          squad_id: string | null
          squad_position: number | null
          updated_at: string
          vapi_assistant_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          description?: string | null
          direction?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          role?: string | null
          squad_id?: string | null
          squad_position?: number | null
          updated_at?: string
          vapi_assistant_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          description?: string | null
          direction?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          role?: string | null
          squad_id?: string | null
          squad_position?: number | null
          updated_at?: string
          vapi_assistant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_agents_squad_id_fkey"
            columns: ["squad_id"]
            isOneToOne: false
            referencedRelation: "voice_squads"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_alert_history: {
        Row: {
          call_id: string | null
          id: string
          is_positive: boolean
          is_read: boolean
          message: string
          rule_id: string | null
          rule_name: string
          triggered_at: string
        }
        Insert: {
          call_id?: string | null
          id?: string
          is_positive?: boolean
          is_read?: boolean
          message: string
          rule_id?: string | null
          rule_name: string
          triggered_at?: string
        }
        Update: {
          call_id?: string | null
          id?: string
          is_positive?: boolean
          is_read?: boolean
          message?: string
          rule_id?: string | null
          rule_name?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_alert_history_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "voice_calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_alert_history_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "voice_alert_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_alert_rules: {
        Row: {
          condition_type: string
          condition_value: string
          created_at: string
          id: string
          is_enabled: boolean
          is_positive: boolean
          name: string
          notify_operators: boolean
          updated_at: string
        }
        Insert: {
          condition_type: string
          condition_value: string
          created_at?: string
          id?: string
          is_enabled?: boolean
          is_positive?: boolean
          name: string
          notify_operators?: boolean
          updated_at?: string
        }
        Update: {
          condition_type?: string
          condition_value?: string
          created_at?: string
          id?: string
          is_enabled?: boolean
          is_positive?: boolean
          name?: string
          notify_operators?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      voice_blacklist: {
        Row: {
          announce_message: string | null
          category: string
          created_at: string
          created_by: string | null
          hit_count: number
          id: string
          is_active: boolean
          kill_mode: string
          last_hit_at: string | null
          normalized_number: string
          notes: string | null
          phone_number: string
          updated_at: string
        }
        Insert: {
          announce_message?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          hit_count?: number
          id?: string
          is_active?: boolean
          kill_mode?: string
          last_hit_at?: string | null
          normalized_number: string
          notes?: string | null
          phone_number: string
          updated_at?: string
        }
        Update: {
          announce_message?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          hit_count?: number
          id?: string
          is_active?: boolean
          kill_mode?: string
          last_hit_at?: string | null
          normalized_number?: string
          notes?: string | null
          phone_number?: string
          updated_at?: string
        }
        Relationships: []
      }
      voice_call_context: {
        Row: {
          account_id: string | null
          caller_phone: string | null
          caller_reason: string | null
          confirmed_intent: string | null
          contact_created: boolean
          contact_found: boolean
          contact_id: string | null
          contact_state: string
          created_at: string
          first_name: string | null
          full_name: string | null
          handoff_ready: boolean
          id: string
          metadata: Json
          normalized_phone: string | null
          source: string | null
          updated_at: string
          vapi_call_id: string
        }
        Insert: {
          account_id?: string | null
          caller_phone?: string | null
          caller_reason?: string | null
          confirmed_intent?: string | null
          contact_created?: boolean
          contact_found?: boolean
          contact_id?: string | null
          contact_state?: string
          created_at?: string
          first_name?: string | null
          full_name?: string | null
          handoff_ready?: boolean
          id?: string
          metadata?: Json
          normalized_phone?: string | null
          source?: string | null
          updated_at?: string
          vapi_call_id: string
        }
        Update: {
          account_id?: string | null
          caller_phone?: string | null
          caller_reason?: string | null
          confirmed_intent?: string | null
          contact_created?: boolean
          contact_found?: boolean
          contact_id?: string | null
          contact_state?: string
          created_at?: string
          first_name?: string | null
          full_name?: string | null
          handoff_ready?: boolean
          id?: string
          metadata?: Json
          normalized_phone?: string | null
          source?: string | null
          updated_at?: string
          vapi_call_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_call_context_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_call_context_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_call_events: {
        Row: {
          attempts: number
          event_type: string
          id: string
          last_error: string | null
          payload: Json
          processed_at: string | null
          received_at: string
          vapi_call_id: string | null
        }
        Insert: {
          attempts?: number
          event_type: string
          id?: string
          last_error?: string | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          vapi_call_id?: string | null
        }
        Update: {
          attempts?: number
          event_type?: string
          id?: string
          last_error?: string | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          vapi_call_id?: string | null
        }
        Relationships: []
      }
      voice_call_tags: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          id: string
          name: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      voice_calls: {
        Row: {
          account_id: string | null
          action_items: string[] | null
          agent_id: string | null
          agent_name: string | null
          ai_recommendations: string[] | null
          artifact_messages: Json | null
          assistants_involved: Json
          call_direction:
            | Database["public"]["Enums"]["voice_call_direction"]
            | null
          call_intent: string | null
          call_outcome: string | null
          call_status: string | null
          contact_id: string | null
          cost: number | null
          created_at: string
          customer_name: string | null
          duration_seconds: number | null
          ended_at: string | null
          escalation_severity: number | null
          handoff_sequence: Json
          id: string
          is_squad_call: boolean
          key_topics: string[] | null
          metadata: Json
          negative_sentiment_moment: Json | null
          phone_number: string | null
          recording_url: string | null
          recovery_priority: number | null
          resolution_notes: string | null
          resolution_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          root_cause_category: string | null
          sentiment: string | null
          squad_id: string | null
          squad_name: string | null
          started_at: string | null
          structured_data_multi: Json
          summary: string | null
          tags: string[]
          transcript: string | null
          updated_at: string
          vapi_call_id: string
        }
        Insert: {
          account_id?: string | null
          action_items?: string[] | null
          agent_id?: string | null
          agent_name?: string | null
          ai_recommendations?: string[] | null
          artifact_messages?: Json | null
          assistants_involved?: Json
          call_direction?:
            | Database["public"]["Enums"]["voice_call_direction"]
            | null
          call_intent?: string | null
          call_outcome?: string | null
          call_status?: string | null
          contact_id?: string | null
          cost?: number | null
          created_at?: string
          customer_name?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          escalation_severity?: number | null
          handoff_sequence?: Json
          id?: string
          is_squad_call?: boolean
          key_topics?: string[] | null
          metadata?: Json
          negative_sentiment_moment?: Json | null
          phone_number?: string | null
          recording_url?: string | null
          recovery_priority?: number | null
          resolution_notes?: string | null
          resolution_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          root_cause_category?: string | null
          sentiment?: string | null
          squad_id?: string | null
          squad_name?: string | null
          started_at?: string | null
          structured_data_multi?: Json
          summary?: string | null
          tags?: string[]
          transcript?: string | null
          updated_at?: string
          vapi_call_id: string
        }
        Update: {
          account_id?: string | null
          action_items?: string[] | null
          agent_id?: string | null
          agent_name?: string | null
          ai_recommendations?: string[] | null
          artifact_messages?: Json | null
          assistants_involved?: Json
          call_direction?:
            | Database["public"]["Enums"]["voice_call_direction"]
            | null
          call_intent?: string | null
          call_outcome?: string | null
          call_status?: string | null
          contact_id?: string | null
          cost?: number | null
          created_at?: string
          customer_name?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          escalation_severity?: number | null
          handoff_sequence?: Json
          id?: string
          is_squad_call?: boolean
          key_topics?: string[] | null
          metadata?: Json
          negative_sentiment_moment?: Json | null
          phone_number?: string | null
          recording_url?: string | null
          recovery_priority?: number | null
          resolution_notes?: string | null
          resolution_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          root_cause_category?: string | null
          sentiment?: string | null
          squad_id?: string | null
          squad_name?: string | null
          started_at?: string | null
          structured_data_multi?: Json
          summary?: string | null
          tags?: string[]
          transcript?: string | null
          updated_at?: string
          vapi_call_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_calls_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_campaign_rules: {
        Row: {
          anchor_offset_seconds: number
          created_at: string
          delay_seconds: number
          expiry_seconds: number | null
          id: string
          is_enabled: boolean
          label: string
          max_attempts: number
          quiet_hours: Json
          retry_delay_seconds: number
          schedule_anchor: string
          trigger_type: Database["public"]["Enums"]["voice_trigger_type"]
          updated_at: string
          vapi_assistant_id: string | null
          vapi_phone_number_id: string | null
          variable_defaults: Json
        }
        Insert: {
          anchor_offset_seconds?: number
          created_at?: string
          delay_seconds?: number
          expiry_seconds?: number | null
          id?: string
          is_enabled?: boolean
          label: string
          max_attempts?: number
          quiet_hours?: Json
          retry_delay_seconds?: number
          schedule_anchor?: string
          trigger_type: Database["public"]["Enums"]["voice_trigger_type"]
          updated_at?: string
          vapi_assistant_id?: string | null
          vapi_phone_number_id?: string | null
          variable_defaults?: Json
        }
        Update: {
          anchor_offset_seconds?: number
          created_at?: string
          delay_seconds?: number
          expiry_seconds?: number | null
          id?: string
          is_enabled?: boolean
          label?: string
          max_attempts?: number
          quiet_hours?: Json
          retry_delay_seconds?: number
          schedule_anchor?: string
          trigger_type?: Database["public"]["Enums"]["voice_trigger_type"]
          updated_at?: string
          vapi_assistant_id?: string | null
          vapi_phone_number_id?: string | null
          variable_defaults?: Json
        }
        Relationships: []
      }
      voice_outbound_jobs: {
        Row: {
          account_id: string | null
          appointment_id: string | null
          attempts: number
          campaign_rule_id: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          dedupe_key: string | null
          dispatched_at: string | null
          expires_at: string | null
          id: string
          journey_id: string | null
          last_error: string | null
          max_attempts: number
          metadata: Json
          phone: string
          scheduled_at: string
          status: Database["public"]["Enums"]["voice_outbound_status"]
          trigger_type: Database["public"]["Enums"]["voice_trigger_type"]
          updated_at: string
          vapi_assistant_id: string
          vapi_call_id: string | null
          vapi_phone_number_id: string | null
          variable_values: Json
        }
        Insert: {
          account_id?: string | null
          appointment_id?: string | null
          attempts?: number
          campaign_rule_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          dispatched_at?: string | null
          expires_at?: string | null
          id?: string
          journey_id?: string | null
          last_error?: string | null
          max_attempts?: number
          metadata?: Json
          phone: string
          scheduled_at: string
          status?: Database["public"]["Enums"]["voice_outbound_status"]
          trigger_type: Database["public"]["Enums"]["voice_trigger_type"]
          updated_at?: string
          vapi_assistant_id: string
          vapi_call_id?: string | null
          vapi_phone_number_id?: string | null
          variable_values?: Json
        }
        Update: {
          account_id?: string | null
          appointment_id?: string | null
          attempts?: number
          campaign_rule_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          dispatched_at?: string | null
          expires_at?: string | null
          id?: string
          journey_id?: string | null
          last_error?: string | null
          max_attempts?: number
          metadata?: Json
          phone?: string
          scheduled_at?: string
          status?: Database["public"]["Enums"]["voice_outbound_status"]
          trigger_type?: Database["public"]["Enums"]["voice_trigger_type"]
          updated_at?: string
          vapi_assistant_id?: string
          vapi_call_id?: string | null
          vapi_phone_number_id?: string | null
          variable_values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "voice_outbound_jobs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_outbound_jobs_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "crm_appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_outbound_jobs_campaign_rule_id_fkey"
            columns: ["campaign_rule_id"]
            isOneToOne: false
            referencedRelation: "voice_campaign_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_outbound_jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_outbound_jobs_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "crm_client_journeys"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_phone_numbers: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          label: string
          metadata: Json
          notes: string | null
          phone_number: string | null
          provider: string | null
          route_ref: string | null
          routes_to: string | null
          sip_uri: string | null
          updated_at: string
          vapi_phone_number_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          metadata?: Json
          notes?: string | null
          phone_number?: string | null
          provider?: string | null
          route_ref?: string | null
          routes_to?: string | null
          sip_uri?: string | null
          updated_at?: string
          vapi_phone_number_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          metadata?: Json
          notes?: string | null
          phone_number?: string | null
          provider?: string | null
          route_ref?: string | null
          routes_to?: string | null
          sip_uri?: string | null
          updated_at?: string
          vapi_phone_number_id?: string
        }
        Relationships: []
      }
      voice_squads: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          updated_at: string
          vapi_squad_id: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          updated_at?: string
          vapi_squad_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          updated_at?: string
          vapi_squad_id?: string | null
        }
        Relationships: []
      }
      waitlist_leads: {
        Row: {
          account_id: string | null
          additional_notes: string | null
          airtable_record_id: string | null
          airtable_status: string | null
          application_id: string | null
          created_at: string
          dedupe_key: string | null
          email: string
          entity_classification: string | null
          entity_name: string | null
          first_name: string
          form_version: string | null
          id: string
          landing_page: string | null
          last_name: string
          marketing_consent: boolean | null
          metadata: Json
          mobile_number: string | null
          notes: string | null
          page: string | null
          primary_areas: string[]
          privacy_acknowledged: boolean | null
          privacy_notice_version: string | null
          referrer: string | null
          role: string | null
          source: string
          stage: number
          stage_dedupe_key: string | null
          stage2_access_mode: string | null
          stage2_answers: Json
          stage2_completed_at: string | null
          stage2_investment: string | null
          stage2_next_step: string | null
          stage2_status: string | null
          stage2_summary: string | null
          stage2_timeline: string | null
          stage3_access_mode: string | null
          stage3_booked_at: string | null
          stage3_session_end: string | null
          stage3_session_start: string | null
          stage3_status: string | null
          stage3_time_zone: string | null
          status: Database["public"]["Enums"]["lead_status"]
          submitted_at: string | null
          synced_at: string | null
          tech_stack_bottlenecks: string | null
          transaction_volume: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
        }
        Insert: {
          account_id?: string | null
          additional_notes?: string | null
          airtable_record_id?: string | null
          airtable_status?: string | null
          application_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          email: string
          entity_classification?: string | null
          entity_name?: string | null
          first_name: string
          form_version?: string | null
          id?: string
          landing_page?: string | null
          last_name: string
          marketing_consent?: boolean | null
          metadata?: Json
          mobile_number?: string | null
          notes?: string | null
          page?: string | null
          primary_areas?: string[]
          privacy_acknowledged?: boolean | null
          privacy_notice_version?: string | null
          referrer?: string | null
          role?: string | null
          source?: string
          stage?: number
          stage_dedupe_key?: string | null
          stage2_access_mode?: string | null
          stage2_answers?: Json
          stage2_completed_at?: string | null
          stage2_investment?: string | null
          stage2_next_step?: string | null
          stage2_status?: string | null
          stage2_summary?: string | null
          stage2_timeline?: string | null
          stage3_access_mode?: string | null
          stage3_booked_at?: string | null
          stage3_session_end?: string | null
          stage3_session_start?: string | null
          stage3_status?: string | null
          stage3_time_zone?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          submitted_at?: string | null
          synced_at?: string | null
          tech_stack_bottlenecks?: string | null
          transaction_volume?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
        }
        Update: {
          account_id?: string | null
          additional_notes?: string | null
          airtable_record_id?: string | null
          airtable_status?: string | null
          application_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          email?: string
          entity_classification?: string | null
          entity_name?: string | null
          first_name?: string
          form_version?: string | null
          id?: string
          landing_page?: string | null
          last_name?: string
          marketing_consent?: boolean | null
          metadata?: Json
          mobile_number?: string | null
          notes?: string | null
          page?: string | null
          primary_areas?: string[]
          privacy_acknowledged?: boolean | null
          privacy_notice_version?: string | null
          referrer?: string | null
          role?: string | null
          source?: string
          stage?: number
          stage_dedupe_key?: string | null
          stage2_access_mode?: string | null
          stage2_answers?: Json
          stage2_completed_at?: string | null
          stage2_investment?: string | null
          stage2_next_step?: string | null
          stage2_status?: string | null
          stage2_summary?: string | null
          stage2_timeline?: string | null
          stage3_access_mode?: string | null
          stage3_booked_at?: string | null
          stage3_session_end?: string | null
          stage3_session_start?: string | null
          stage3_status?: string | null
          stage3_time_zone?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          submitted_at?: string | null
          synced_at?: string | null
          tech_stack_bottlenecks?: string | null
          transaction_volume?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "waitlist_leads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "crm_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      clone_backends_safe: {
        Row: {
          admin_email: string | null
          clone_id: string | null
          created_at: string | null
          edge_functions: Json | null
          error_message: string | null
          id: string | null
          migration_version: string | null
          migrations_applied: Json | null
          region: string | null
          secret_shells: Json | null
          source_ref: string | null
          source_repo: string | null
          source_sha: string | null
          status: Database["public"]["Enums"]["clone_backend_status"] | null
          status_detail: string | null
          supabase_project_ref: string | null
          supabase_url: string | null
          updated_at: string | null
        }
        Insert: {
          admin_email?: string | null
          clone_id?: string | null
          created_at?: string | null
          edge_functions?: Json | null
          error_message?: string | null
          id?: string | null
          migration_version?: string | null
          migrations_applied?: Json | null
          region?: string | null
          secret_shells?: Json | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"] | null
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_email?: string | null
          clone_id?: string | null
          created_at?: string | null
          edge_functions?: Json | null
          error_message?: string | null
          id?: string | null
          migration_version?: string | null
          migrations_applied?: Json | null
          region?: string | null
          secret_shells?: Json | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"] | null
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      clones_missing_isolated_backend: {
        Row: {
          backend_status: string | null
          clone_id: string | null
          created_at: string | null
          name: string | null
          owner_user_id: string | null
          provisioning_method:
            | Database["public"]["Enums"]["provisioning_method"]
            | null
          slug: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      acknowledge_plan_change: {
        Args: { _event_id: string; _tenant_id: string }
        Returns: Json
      }
      advance_tenant_billing_period: {
        Args: {
          _period_end?: string
          _period_start: string
          _tenant_id: string
        }
        Returns: Json
      }
      api_usage_fleet_summary: {
        Args: { _period_start?: string }
        Returns: Json
      }
      api_usage_tenant_summary: {
        Args: { _period_start?: string; _tenant_id: string }
        Returns: Json
      }
      apply_seat_plan_change: {
        Args: { _plan_slug: string; _source_ref: string; _tenant_id: string }
        Returns: Json
      }
      apply_topup: {
        Args: {
          _metadata?: Json
          _pack_id: string
          _source_ref?: string
          _tenant_id: string
        }
        Returns: Json
      }
      can_access_security_assessment: {
        Args: { _assessment_id: string }
        Returns: boolean
      }
      can_assign_role: {
        Args: {
          _assigner_id: string
          _target_role: Database["public"]["Enums"]["app_role"]
        }
        Returns: boolean
      }
      can_manage_user: {
        Args: { _manager_id: string; _target_user_id: string }
        Returns: boolean
      }
      cancel_token_reservation: {
        Args: { _job_id: string; _reason?: string }
        Returns: Json
      }
      check_api_rate_limit: {
        Args: { _key_id: string; _limit?: number }
        Returns: Json
      }
      cleanup_billing_attribution: { Args: never; Returns: Json }
      clone_has_dedicated_backend: {
        Args: { _clone_id: string }
        Returns: boolean
      }
      clone_requires_backend: { Args: { _clone_id: string }; Returns: boolean }
      close_api_usage_period: {
        Args: { _period_start: string; _tenant_id: string }
        Returns: Json
      }
      codex_fleet_overview: {
        Args: never
        Returns: {
          codex_nightly_enabled: boolean
          github_owner: string
          github_repo: string
          id: string
          last_scan: Json
          name: string
          open_findings: Json
          repo_full_name: string
          slug: string
          sync_status: string
        }[]
      }
      commit_seat: { Args: { _seat_id: string }; Returns: Json }
      commit_tokens: {
        Args: { _actual_tokens: number; _job_id: string; _result_meta?: Json }
        Returns: Json
      }
      crm_convert_lead: {
        Args: { _lead_id: string; _owner?: string }
        Returns: Json
      }
      crm_pipeline_summary: { Args: never; Returns: Json }
      crm_recompute_all_health: { Args: never; Returns: Json }
      crm_recompute_health: { Args: { _account_id: string }; Returns: number }
      crm_seed_onboarding: { Args: { _account_id: string }; Returns: Json }
      crm_sweep: { Args: never; Returns: Json }
      cron_delivery_health: {
        Args: { _since_hours?: number }
        Returns: {
          active: boolean
          delivered: boolean
          jobname: string
          last_http_error: string
          last_http_status: number
          last_run_at: string
          last_run_status: string
          runs: number
          schedule: string
        }[]
      }
      entitlement_for_subscription: {
        Args: { _sub_id: string }
        Returns: {
          clone_id: string
          id: string
          seat_plan_id: string
          status: string
        }[]
      }
      expire_stale_reservations: { Args: never; Returns: Json }
      expire_stale_seat_reservations: { Args: never; Returns: Json }
      feedback_campaign_key: {
        Args: { _at?: string; _tenant_created_at: string }
        Returns: string
      }
      feedback_delivery_health: { Args: never; Returns: Json }
      feedback_forward_backoff: { Args: { _attempts: number }; Returns: string }
      feedback_forward_max_attempts: { Args: never; Returns: number }
      feedback_pending_forward: {
        Args: { _limit?: number }
        Returns: {
          attempts: number
          last_error: string
          submission_id: string
        }[]
      }
      feedback_prompt_due: {
        Args: { _origin_user_id?: string; _tenant_id: string }
        Returns: Json
      }
      feedback_retry_now: { Args: { _submission_id?: string }; Returns: number }
      grant_tokens: {
        Args: {
          _expires_at?: string
          _reason: string
          _tenant_id: string
          _tokens: number
        }
        Returns: Json
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      heartbeat_device: { Args: { _device_id: string }; Returns: Json }
      highest_role_level: { Args: { _user_id: string }; Returns: number }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_high_king: { Args: { _user_id: string }; Returns: boolean }
      is_operator: { Args: { _user_id: string }; Returns: boolean }
      is_security_partner_member: {
        Args: { _partner_id: string }
        Returns: boolean
      }
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      issue_due_plan_allowances: { Args: never; Returns: Json }
      issue_plan_allowance: {
        Args: { _period_start?: string; _tenant_id: string }
        Returns: Json
      }
      mark_feedback_forwarded: {
        Args: { _error?: string; _ok: boolean; _submission_id: string }
        Returns: undefined
      }
      prune_repo_blob_analysis: { Args: never; Returns: number }
      purge_api_usage_events: { Args: never; Returns: Json }
      purge_deployment_events: { Args: never; Returns: number }
      purge_hosting_teardowns: { Args: never; Returns: number }
      purge_log_tables: {
        Args: never
        Returns: {
          deleted_rows: number
          table_name: string
        }[]
      }
      recompute_seat_device_count: {
        Args: { _seat_id: string }
        Returns: number
      }
      recompute_seats_used: { Args: { _clone_id: string }; Returns: number }
      recompute_token_balance: {
        Args: { _tenant_id: string }
        Returns: undefined
      }
      record_api_usage_event: {
        Args: {
          _call_status?: string
          _clone_id: string
          _feature?: string
          _idempotency_key: string
          _metadata?: Json
          _model?: string
          _occurred_at?: string
          _quantity: number
          _secret_name: string
          _tenant_id: string
        }
        Returns: Json
      }
      refresh_token_balance: {
        Args: { _max_age_seconds?: number; _tenant_id: string }
        Returns: Json
      }
      refund_job: { Args: { _job_id: string; _reason?: string }; Returns: Json }
      register_device: {
        Args: {
          _clone_id: string
          _device_fingerprint: string
          _device_label?: string
          _external_user_id: string
          _ip_address?: string
          _platform?: string
          _user_agent?: string
        }
        Returns: Json
      }
      release_device: {
        Args: {
          _clone_id?: string
          _device_fingerprint?: string
          _device_id?: string
          _external_user_id?: string
          _reason?: string
        }
        Returns: Json
      }
      release_seat: {
        Args: { _clone_id: string; _external_user_id: string; _reason?: string }
        Returns: Json
      }
      release_token_job: {
        Args: { _job_id: string; _reason?: string }
        Returns: Json
      }
      reorder_payment_methods: {
        Args: { _ordered_ids: string[]; _tenant_id: string }
        Returns: Json
      }
      reserve_seat: {
        Args: {
          _clone_id: string
          _display_name: string
          _email: string
          _external_user_id: string
          _idempotency_key: string
          _ttl_seconds?: number
        }
        Returns: Json
      }
      reserve_tokens: {
        Args: {
          _clone_id: string
          _estimated_tokens: number
          _idempotency_key: string
          _kind: string
          _request_payload?: Json
          _tenant_id: string
          _ttl_seconds?: number
        }
        Returns: Json
      }
      resolve_api_key_billability: {
        Args: { _clone_id: string; _secret_name: string }
        Returns: string
      }
      revoke_scheduled_keys: { Args: never; Returns: Json }
      role_level: {
        Args: { _role: Database["public"]["Enums"]["app_role"] }
        Returns: number
      }
      schedule_key_revoke: {
        Args: { _at: string; _key_id: string }
        Returns: Json
      }
      security_storage_assessment_id: {
        Args: { object_name: string }
        Returns: string
      }
      submit_feedback: {
        Args: { _payload: Json; _tenant_id: string }
        Returns: Json
      }
      tenant_usage_summary: { Args: { _tenant_id: string }; Returns: Json }
      token_expiry_days: { Args: never; Returns: number }
      token_expiry_schedule: {
        Args: { _tenant_id: string }
        Returns: {
          expires_at: string
          kind: string
          reason: string
          remaining: number
        }[]
      }
      unseen_plan_changes: {
        Args: { _tenant_id: string }
        Returns: {
          acknowledged_at: string | null
          created_at: string
          credits_expire_at: string | null
          credits_granted: number
          from_plan_name: string | null
          from_plan_slug: string | null
          id: string
          modules_reconciled_at: string | null
          reconciliation_id: string | null
          source_ref: string
          tenant_id: string
          to_plan_name: string
          to_plan_slug: string
        }[]
        SetofOptions: {
          from: "*"
          to: "plan_change_events"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      app_role: "super_admin" | "admin" | "operator" | "user" | "high_king"
      brand_assignment_status: "pending" | "applied" | "drifted" | "failed"
      brand_profile_status: "draft" | "published" | "archived"
      cascade_event_status:
        | "pending"
        | "running"
        | "completed"
        | "failed"
        | "partial"
      cascade_mode: "pr" | "auto_merge" | "notify"
      cascade_result_status:
        | "queued"
        | "pushing"
        | "succeeded"
        | "failed"
        | "pr_opened"
        | "skipped"
      cascade_schedule_kind: "fleet_cascade" | "module_sync" | "brand_sync"
      cascade_trigger: "manual" | "commit" | "scheduled"
      clone_backend_status:
        | "pending"
        | "provisioning"
        | "migrating"
        | "seeding_admin"
        | "ready"
        | "failed"
        | "suspended"
      clone_stripe_mode: "platform" | "own_account" | "connect"
      clone_stripe_status: "pending" | "active" | "rotated" | "revoked"
      codex_finding_severity: "critical" | "high" | "medium" | "low" | "info"
      codex_finding_state:
        | "open"
        | "triaging"
        | "fix_drafted"
        | "pr_open"
        | "fix_merged"
        | "resolved"
        | "dismissed"
        | "false_positive"
      codex_remediation_status:
        | "queued"
        | "dispatched"
        | "pr_opened"
        | "pr_updated"
        | "merged"
        | "closed"
        | "failed"
        | "canceled"
        | "approved"
        | "rejected"
        | "changes_requested"
      codex_scan_kind:
        | "manual"
        | "nightly_full"
        | "pr_open"
        | "targeted_path"
        | "post_merge_revalidate"
      codex_scan_status:
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "canceled"
      crm_activity_kind:
        | "note"
        | "call"
        | "email"
        | "meeting"
        | "system"
        | "status_change"
        | "payment"
        | "ticket"
        | "feedback"
        | "dispute"
        | "churn"
      crm_appointment_kind:
        | "discovery"
        | "strategy_phone"
        | "strategy_zoom"
        | "ifc_phone"
        | "ifc_zoom"
        | "other"
        | "strategic_review"
        | "discovery_session"
        | "guided_demo"
        | "enterprise_consultation"
        | "kickoff"
      crm_appointment_status:
        | "scheduled"
        | "confirmed"
        | "completed"
        | "no_show"
        | "canceled"
        | "rescheduled"
      crm_churn_reason:
        | "price"
        | "missing_capability"
        | "switched_provider"
        | "internal_build"
        | "non_payment"
        | "business_closed"
        | "poor_experience"
        | "other"
      crm_deal_stage:
        | "discovery"
        | "demo"
        | "proposal"
        | "contract"
        | "won"
        | "lost"
      crm_dispute_kind:
        | "chargeback"
        | "billing_disagreement"
        | "service_credit"
        | "contractual"
        | "other"
      crm_dispute_status:
        | "open"
        | "under_review"
        | "evidence_submitted"
        | "won"
        | "lost"
        | "withdrawn"
        | "settled"
      crm_fit_knowledge_kind:
        | "icp"
        | "case_study"
        | "positioning"
        | "disqualification"
        | "pricing"
        | "objection"
        | "process"
        | "other"
      crm_fit_status: "queued" | "running" | "complete" | "failed"
      crm_fit_verdict:
        | "strong_fit"
        | "fit"
        | "conditional"
        | "poor_fit"
        | "decline"
      crm_lifecycle_stage:
        | "lead"
        | "opportunity"
        | "onboarding"
        | "active"
        | "at_risk"
        | "churned"
      crm_offboarding_path:
        | "ownership_transfer"
        | "export_and_terminate"
        | "terminate_only"
      crm_task_status: "open" | "in_progress" | "done" | "canceled"
      crm_ticket_severity: "low" | "normal" | "high" | "critical"
      crm_ticket_status:
        | "open"
        | "in_progress"
        | "waiting_client"
        | "resolved"
        | "closed"
      crm_ticket_type: "support" | "bug" | "billing" | "feature" | "incident"
      drift_severity: "low" | "medium" | "high"
      handoff_path: "rebuild_twin" | "enterprise_transfer"
      handoff_state:
        | "draft"
        | "dry_run_ready"
        | "awaiting_client_consent"
        | "snapshot_pending"
        | "snapshot_ready"
        | "twin_provisioning"
        | "twin_ready"
        | "data_syncing"
        | "cutover_scheduled"
        | "cutover_in_progress"
        | "complete"
        | "rolled_back"
        | "failed"
        | "canceled"
      lead_status:
        | "new"
        | "contacted"
        | "qualified"
        | "disqualified"
        | "converted"
      ledger_kind:
        | "grant"
        | "topup"
        | "debit"
        | "refund"
        | "adjustment"
        | "expiry"
        | "reserve"
        | "release"
      ledger_source: "subscription" | "topup" | "manual" | "system" | "report"
      module_status: "proposed" | "approved" | "archived" | "rejected"
      notification_kind:
        | "clone_gate_armed"
        | "clone_gate_expiring"
        | "clone_gate_locked"
        | "clone_gate_unlocked"
        | "cascade_completed"
        | "cascade_failed"
        | "cascade_partial"
        | "cascade_started"
        | "drift_high"
        | "drift_medium"
        | "clone_created"
        | "clone_deleted"
        | "module_installed"
        | "module_removed"
        | "cascade_awaiting_approval"
        | "cascade_approved"
        | "cascade_rejected"
        | "library_entry_approved"
        | "library_entry_rejected"
        | "tokens_alert"
        | "tokens_key_first_use"
        | "tokens_key_issued"
        | "tokens_key_rotated"
        | "seat_limit_approaching"
        | "seat_limit_reached"
        | "seat_plan_changed"
        | "device_limit_reached"
        | "device_registered"
        | "device_released"
        | "lead_captured"
        | "purchase_completed"
        | "crm_sla_breach"
        | "crm_renewal_due"
        | "crm_retention_due"
        | "crm_task_assigned"
        | "lead_stage_two"
        | "lead_stage_three"
        | "support_ticket_created"
        | "support_ticket_escalated"
        | "remediation_awaiting_validation"
        | "remediation_auto_completed"
        | "remediation_failed"
        | "handoff_consent_received"
        | "github_app_access_drift"
        | "api_usage_settlement_failed"
        | "security_assessment_created"
        | "security_report_submitted"
        | "security_finding_created"
        | "security_retest_requested"
        | "security_assessment_closed"
        | "deployment_live"
        | "deployment_failed"
        | "deployment_domain_pending"
        | "deployment_build_failed"
        | "voice_call_flagged"
        | "voice_outbound_failed"
        | "voice_blacklist_hit"
        | "phone_missed_call"
        | "agreement_provisioned"
        | "agreement_signed"
        | "agreement_declined"
        | "migration_drift"
      notification_severity: "info" | "success" | "warning" | "error"
      overage_policy: "block" | "topup_only" | "pay_as_you_go"
      provisioning_method: "fork" | "template" | "clone"
      remediation_action_type:
        | "pr_merge"
        | "sql_migration"
        | "edge_function_deploy"
        | "monitor_recovery"
        | "rescan"
        | "manual"
      remediation_run_status:
        | "planned"
        | "awaiting_validation"
        | "approved"
        | "rejected"
        | "executing"
        | "succeeded"
        | "failed"
        | "skipped"
      report_job_status:
        | "pending"
        | "reserved"
        | "completed"
        | "failed"
        | "refunded"
        | "canceled"
      support_breakage_vector:
        | "full_outage"
        | "partial_outage"
        | "degraded_performance"
        | "single_feature"
        | "intermittent"
        | "cosmetic"
        | "none"
      support_ticket_category:
        | "security_threat"
        | "api_outage"
        | "provider_downtime"
        | "bug"
        | "performance"
        | "data_issue"
        | "access"
        | "billing"
        | "feature_request"
        | "question"
        | "other"
      support_ticket_status:
        | "new"
        | "triaged"
        | "remediating"
        | "awaiting_validation"
        | "remediated"
        | "resolved"
        | "closed"
        | "failed"
      sync_status: "in_sync" | "behind" | "cascading" | "failed" | "unknown"
      tenant_status: "active" | "past_due" | "canceled"
      ticket_priority: "P0" | "P1" | "P2" | "P3" | "P4"
      voice_call_direction: "inbound" | "outbound"
      voice_outbound_status:
        | "pending"
        | "dispatching"
        | "dispatched"
        | "completed"
        | "failed"
        | "canceled"
        | "expired"
      voice_trigger_type:
        | "opt_in_follow_up"
        | "quiz_follow_up"
        | "nurture"
        | "discovery_reminder"
        | "discovery_no_show"
        | "strategy_confirmation"
        | "strategy_no_show"
        | "ifc_confirmation"
        | "ifc_no_show"
        | "manual"
        | "questionnaire_follow_up"
        | "review_booking_follow_up"
        | "review_confirmation"
        | "session_reminder"
        | "session_no_show"
        | "kickoff_scheduler"
        | "checkin_at_risk"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: ["super_admin", "admin", "operator", "user", "high_king"],
      brand_assignment_status: ["pending", "applied", "drifted", "failed"],
      brand_profile_status: ["draft", "published", "archived"],
      cascade_event_status: [
        "pending",
        "running",
        "completed",
        "failed",
        "partial",
      ],
      cascade_mode: ["pr", "auto_merge", "notify"],
      cascade_result_status: [
        "queued",
        "pushing",
        "succeeded",
        "failed",
        "pr_opened",
        "skipped",
      ],
      cascade_schedule_kind: ["fleet_cascade", "module_sync", "brand_sync"],
      cascade_trigger: ["manual", "commit", "scheduled"],
      clone_backend_status: [
        "pending",
        "provisioning",
        "migrating",
        "seeding_admin",
        "ready",
        "failed",
        "suspended",
      ],
      clone_stripe_mode: ["platform", "own_account", "connect"],
      clone_stripe_status: ["pending", "active", "rotated", "revoked"],
      codex_finding_severity: ["critical", "high", "medium", "low", "info"],
      codex_finding_state: [
        "open",
        "triaging",
        "fix_drafted",
        "pr_open",
        "fix_merged",
        "resolved",
        "dismissed",
        "false_positive",
      ],
      codex_remediation_status: [
        "queued",
        "dispatched",
        "pr_opened",
        "pr_updated",
        "merged",
        "closed",
        "failed",
        "canceled",
        "approved",
        "rejected",
        "changes_requested",
      ],
      codex_scan_kind: [
        "manual",
        "nightly_full",
        "pr_open",
        "targeted_path",
        "post_merge_revalidate",
      ],
      codex_scan_status: [
        "queued",
        "running",
        "completed",
        "failed",
        "canceled",
      ],
      crm_activity_kind: [
        "note",
        "call",
        "email",
        "meeting",
        "system",
        "status_change",
        "payment",
        "ticket",
        "feedback",
        "dispute",
        "churn",
      ],
      crm_appointment_kind: [
        "discovery",
        "strategy_phone",
        "strategy_zoom",
        "ifc_phone",
        "ifc_zoom",
        "other",
        "strategic_review",
        "discovery_session",
        "guided_demo",
        "enterprise_consultation",
        "kickoff",
      ],
      crm_appointment_status: [
        "scheduled",
        "confirmed",
        "completed",
        "no_show",
        "canceled",
        "rescheduled",
      ],
      crm_churn_reason: [
        "price",
        "missing_capability",
        "switched_provider",
        "internal_build",
        "non_payment",
        "business_closed",
        "poor_experience",
        "other",
      ],
      crm_deal_stage: [
        "discovery",
        "demo",
        "proposal",
        "contract",
        "won",
        "lost",
      ],
      crm_dispute_kind: [
        "chargeback",
        "billing_disagreement",
        "service_credit",
        "contractual",
        "other",
      ],
      crm_dispute_status: [
        "open",
        "under_review",
        "evidence_submitted",
        "won",
        "lost",
        "withdrawn",
        "settled",
      ],
      crm_fit_knowledge_kind: [
        "icp",
        "case_study",
        "positioning",
        "disqualification",
        "pricing",
        "objection",
        "process",
        "other",
      ],
      crm_fit_status: ["queued", "running", "complete", "failed"],
      crm_fit_verdict: [
        "strong_fit",
        "fit",
        "conditional",
        "poor_fit",
        "decline",
      ],
      crm_lifecycle_stage: [
        "lead",
        "opportunity",
        "onboarding",
        "active",
        "at_risk",
        "churned",
      ],
      crm_offboarding_path: [
        "ownership_transfer",
        "export_and_terminate",
        "terminate_only",
      ],
      crm_task_status: ["open", "in_progress", "done", "canceled"],
      crm_ticket_severity: ["low", "normal", "high", "critical"],
      crm_ticket_status: [
        "open",
        "in_progress",
        "waiting_client",
        "resolved",
        "closed",
      ],
      crm_ticket_type: ["support", "bug", "billing", "feature", "incident"],
      drift_severity: ["low", "medium", "high"],
      handoff_path: ["rebuild_twin", "enterprise_transfer"],
      handoff_state: [
        "draft",
        "dry_run_ready",
        "awaiting_client_consent",
        "snapshot_pending",
        "snapshot_ready",
        "twin_provisioning",
        "twin_ready",
        "data_syncing",
        "cutover_scheduled",
        "cutover_in_progress",
        "complete",
        "rolled_back",
        "failed",
        "canceled",
      ],
      lead_status: [
        "new",
        "contacted",
        "qualified",
        "disqualified",
        "converted",
      ],
      ledger_kind: [
        "grant",
        "topup",
        "debit",
        "refund",
        "adjustment",
        "expiry",
        "reserve",
        "release",
      ],
      ledger_source: ["subscription", "topup", "manual", "system", "report"],
      module_status: ["proposed", "approved", "archived", "rejected"],
      notification_kind: [
        "clone_gate_armed",
        "clone_gate_expiring",
        "clone_gate_locked",
        "clone_gate_unlocked",
        "cascade_completed",
        "cascade_failed",
        "cascade_partial",
        "cascade_started",
        "drift_high",
        "drift_medium",
        "clone_created",
        "clone_deleted",
        "module_installed",
        "module_removed",
        "cascade_awaiting_approval",
        "cascade_approved",
        "cascade_rejected",
        "library_entry_approved",
        "library_entry_rejected",
        "tokens_alert",
        "tokens_key_first_use",
        "tokens_key_issued",
        "tokens_key_rotated",
        "seat_limit_approaching",
        "seat_limit_reached",
        "seat_plan_changed",
        "device_limit_reached",
        "device_registered",
        "device_released",
        "lead_captured",
        "purchase_completed",
        "crm_sla_breach",
        "crm_renewal_due",
        "crm_retention_due",
        "crm_task_assigned",
        "lead_stage_two",
        "lead_stage_three",
        "support_ticket_created",
        "support_ticket_escalated",
        "remediation_awaiting_validation",
        "remediation_auto_completed",
        "remediation_failed",
        "handoff_consent_received",
        "github_app_access_drift",
        "api_usage_settlement_failed",
        "security_assessment_created",
        "security_report_submitted",
        "security_finding_created",
        "security_retest_requested",
        "security_assessment_closed",
        "deployment_live",
        "deployment_failed",
        "deployment_domain_pending",
        "deployment_build_failed",
        "voice_call_flagged",
        "voice_outbound_failed",
        "voice_blacklist_hit",
        "phone_missed_call",
        "agreement_provisioned",
        "agreement_signed",
        "agreement_declined",
        "migration_drift",
      ],
      notification_severity: ["info", "success", "warning", "error"],
      overage_policy: ["block", "topup_only", "pay_as_you_go"],
      provisioning_method: ["fork", "template", "clone"],
      remediation_action_type: [
        "pr_merge",
        "sql_migration",
        "edge_function_deploy",
        "monitor_recovery",
        "rescan",
        "manual",
      ],
      remediation_run_status: [
        "planned",
        "awaiting_validation",
        "approved",
        "rejected",
        "executing",
        "succeeded",
        "failed",
        "skipped",
      ],
      report_job_status: [
        "pending",
        "reserved",
        "completed",
        "failed",
        "refunded",
        "canceled",
      ],
      support_breakage_vector: [
        "full_outage",
        "partial_outage",
        "degraded_performance",
        "single_feature",
        "intermittent",
        "cosmetic",
        "none",
      ],
      support_ticket_category: [
        "security_threat",
        "api_outage",
        "provider_downtime",
        "bug",
        "performance",
        "data_issue",
        "access",
        "billing",
        "feature_request",
        "question",
        "other",
      ],
      support_ticket_status: [
        "new",
        "triaged",
        "remediating",
        "awaiting_validation",
        "remediated",
        "resolved",
        "closed",
        "failed",
      ],
      sync_status: ["in_sync", "behind", "cascading", "failed", "unknown"],
      tenant_status: ["active", "past_due", "canceled"],
      ticket_priority: ["P0", "P1", "P2", "P3", "P4"],
      voice_call_direction: ["inbound", "outbound"],
      voice_outbound_status: [
        "pending",
        "dispatching",
        "dispatched",
        "completed",
        "failed",
        "canceled",
        "expired",
      ],
      voice_trigger_type: [
        "opt_in_follow_up",
        "quiz_follow_up",
        "nurture",
        "discovery_reminder",
        "discovery_no_show",
        "strategy_confirmation",
        "strategy_no_show",
        "ifc_confirmation",
        "ifc_no_show",
        "manual",
        "questionnaire_follow_up",
        "review_booking_follow_up",
        "review_confirmation",
        "session_reminder",
        "session_no_show",
        "kickoff_scheduler",
        "checkin_at_risk",
      ],
    },
  },
} as const
