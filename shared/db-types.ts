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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ai_summaries: {
        Row: {
          alerts: Json | null
          appointment_id: string | null
          doctor_feedback:
            | Database["public"]["Enums"]["doctor_feedback_type"]
            | null
          form_response_id: string | null
          generated_at: string
          id: string
          model_used: string | null
          summary: Json | null
        }
        Insert: {
          alerts?: Json | null
          appointment_id?: string | null
          doctor_feedback?:
            | Database["public"]["Enums"]["doctor_feedback_type"]
            | null
          form_response_id?: string | null
          generated_at?: string
          id?: string
          model_used?: string | null
          summary?: Json | null
        }
        Update: {
          alerts?: Json | null
          appointment_id?: string | null
          doctor_feedback?:
            | Database["public"]["Enums"]["doctor_feedback_type"]
            | null
          form_response_id?: string | null
          generated_at?: string
          id?: string
          model_used?: string | null
          summary?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_summaries_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_summaries_form_response_id_fkey"
            columns: ["form_response_id"]
            isOneToOne: false
            referencedRelation: "form_responses"
            referencedColumns: ["id"]
          },
        ]
      }
      appointment_types: {
        Row: {
          color: string | null
          default_duration_min: number
          description: string | null
          form_id: string | null
          form_schema_key: string | null
          id: string
          is_active: boolean
          name: string
          price_euros: number | null
          specialty_id: string
        }
        Insert: {
          color?: string | null
          default_duration_min?: number
          description?: string | null
          form_id?: string | null
          form_schema_key?: string | null
          id?: string
          is_active?: boolean
          name: string
          price_euros?: number | null
          specialty_id: string
        }
        Update: {
          color?: string | null
          default_duration_min?: number
          description?: string | null
          form_id?: string | null
          form_schema_key?: string | null
          id?: string
          is_active?: boolean
          name?: string
          price_euros?: number | null
          specialty_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointment_types_form_id_fkey"
            columns: ["form_id"]
            isOneToOne: false
            referencedRelation: "forms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_types_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          appointment_type_id: string | null
          created_at: string
          doctor_id: string
          duration_min: number
          id: string
          notes: string | null
          patient_id: string
          scheduled_at: string
          status: Database["public"]["Enums"]["appointment_status"]
          updated_at: string
        }
        Insert: {
          appointment_type_id?: string | null
          created_at?: string
          doctor_id: string
          duration_min?: number
          id?: string
          notes?: string | null
          patient_id: string
          scheduled_at: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Update: {
          appointment_type_id?: string | null
          created_at?: string
          doctor_id?: string
          duration_min?: number
          id?: string
          notes?: string | null
          patient_id?: string
          scheduled_at?: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_appointment_type_id_fkey"
            columns: ["appointment_type_id"]
            isOneToOne: false
            referencedRelation: "appointment_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      data_export_requests: {
        Row: {
          completed_at: string | null
          download_url: string | null
          expires_at: string | null
          id: string
          patient_id: string
          requested_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          download_url?: string | null
          expires_at?: string | null
          id?: string
          patient_id: string
          requested_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          download_url?: string | null
          expires_at?: string | null
          id?: string
          patient_id?: string
          requested_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_export_requests_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_appointment_types: {
        Row: {
          appointment_type_id: string
          created_at: string
          doctor_id: string
          id: string
        }
        Insert: {
          appointment_type_id: string
          created_at?: string
          doctor_id: string
          id?: string
        }
        Update: {
          appointment_type_id?: string
          created_at?: string
          doctor_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_appointment_types_appointment_type_id_fkey"
            columns: ["appointment_type_id"]
            isOneToOne: false
            referencedRelation: "appointment_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_appointment_types_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_availability: {
        Row: {
          day_of_week: number
          doctor_id: string
          end_time: string
          id: string
          is_recurring: boolean
          start_time: string
        }
        Insert: {
          day_of_week: number
          doctor_id: string
          end_time: string
          id?: string
          is_recurring?: boolean
          start_time: string
        }
        Update: {
          day_of_week?: number
          doctor_id?: string
          end_time?: string
          id?: string
          is_recurring?: boolean
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_availability_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_availability_blocks: {
        Row: {
          blocked_date: string
          doctor_id: string
          id: string
          reason: string | null
        }
        Insert: {
          blocked_date: string
          doctor_id: string
          id?: string
          reason?: string | null
        }
        Update: {
          blocked_date?: string
          doctor_id?: string
          id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "doctor_availability_blocks_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_specialties: {
        Row: {
          created_at: string
          doctor_id: string
          id: string
          specialty_id: string
        }
        Insert: {
          created_at?: string
          doctor_id: string
          id?: string
          specialty_id: string
        }
        Update: {
          created_at?: string
          doctor_id?: string
          id?: string
          specialty_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_specialties_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_specialties_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
        ]
      }
      doctors: {
        Row: {
          bio: string | null
          id: string
          is_active: boolean
          specialty: string | null
        }
        Insert: {
          bio?: string | null
          id: string
          is_active?: boolean
          specialty?: string | null
        }
        Update: {
          bio?: string | null
          id?: string
          is_active?: boolean
          specialty?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "doctors_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      form_responses: {
        Row: {
          appointment_id: string | null
          completed_at: string | null
          created_at: string
          form_schema_key: string | null
          form_version: number | null
          id: string
          patient_id: string
          responses: Json | null
          status: Database["public"]["Enums"]["form_status"]
        }
        Insert: {
          appointment_id?: string | null
          completed_at?: string | null
          created_at?: string
          form_schema_key?: string | null
          form_version?: number | null
          id?: string
          patient_id: string
          responses?: Json | null
          status?: Database["public"]["Enums"]["form_status"]
        }
        Update: {
          appointment_id?: string | null
          completed_at?: string | null
          created_at?: string
          form_schema_key?: string | null
          form_version?: number | null
          id?: string
          patient_id?: string
          responses?: Json | null
          status?: Database["public"]["Enums"]["form_status"]
        }
        Relationships: [
          {
            foreignKeyName: "form_responses_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_responses_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      form_versions: {
        Row: {
          form_id: string
          id: string
          published_at: string
          published_by: string | null
          sections: Json
          version: number
        }
        Insert: {
          form_id: string
          id?: string
          published_at?: string
          published_by?: string | null
          sections: Json
          version: number
        }
        Update: {
          form_id?: string
          id?: string
          published_at?: string
          published_by?: string | null
          sections?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "form_versions_form_id_fkey"
            columns: ["form_id"]
            isOneToOne: false
            referencedRelation: "forms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_versions_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      forms: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          estimated_minutes: number | null
          id: string
          name: string
          sections: Json
          status: Database["public"]["Enums"]["form_builder_status"]
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          estimated_minutes?: number | null
          id?: string
          name: string
          sections?: Json
          status?: Database["public"]["Enums"]["form_builder_status"]
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          estimated_minutes?: number | null
          id?: string
          name?: string
          sections?: Json
          status?: Database["public"]["Enums"]["form_builder_status"]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "forms_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          channel: Database["public"]["Enums"]["notification_channel"]
          content: string | null
          id: string
          recipient_id: string
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
          type: Database["public"]["Enums"]["notification_type"]
        }
        Insert: {
          channel?: Database["public"]["Enums"]["notification_channel"]
          content?: string | null
          id?: string
          recipient_id: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          type: Database["public"]["Enums"]["notification_type"]
        }
        Update: {
          channel?: Database["public"]["Enums"]["notification_channel"]
          content?: string | null
          id?: string
          recipient_id?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          type?: Database["public"]["Enums"]["notification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          accepted_terms_version: string | null
          chosen_name: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          email_notifications_enabled: boolean
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          gender_identity: string | null
          id: string
          insurance_info: string | null
          legal_name: string | null
          phone: string | null
          preferred_language: Database["public"]["Enums"]["preferred_language"]
          pronouns: string | null
          registration_completed: boolean
          role: Database["public"]["Enums"]["app_role"]
          sexual_orientation: string | null
          sms_notifications_enabled: boolean
          updated_at: string
        }
        Insert: {
          accepted_terms_version?: string | null
          chosen_name?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          email_notifications_enabled?: boolean
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          gender_identity?: string | null
          id: string
          insurance_info?: string | null
          legal_name?: string | null
          phone?: string | null
          preferred_language?: Database["public"]["Enums"]["preferred_language"]
          pronouns?: string | null
          registration_completed?: boolean
          role?: Database["public"]["Enums"]["app_role"]
          sexual_orientation?: string | null
          sms_notifications_enabled?: boolean
          updated_at?: string
        }
        Update: {
          accepted_terms_version?: string | null
          chosen_name?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          email_notifications_enabled?: boolean
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          gender_identity?: string | null
          id?: string
          insurance_info?: string | null
          legal_name?: string | null
          phone?: string | null
          preferred_language?: Database["public"]["Enums"]["preferred_language"]
          pronouns?: string | null
          registration_completed?: boolean
          role?: Database["public"]["Enums"]["app_role"]
          sexual_orientation?: string | null
          sms_notifications_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      specialties: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      terms_acceptances: {
        Row: {
          accepted_at: string
          id: string
          ip_address: string | null
          terms_version: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          accepted_at?: string
          id?: string
          ip_address?: string | null
          terms_version: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          accepted_at?: string
          id?: string
          ip_address?: string | null
          terms_version?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "terms_acceptances_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_slot_available: {
        Args: {
          _doctor_id: string
          _duration_min: number
          _scheduled_at: string
        }
        Returns: boolean
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      get_available_slots: {
        Args: {
          _appointment_type_id: string
          _doctor_id_filter?: string
          _target_date: string
        }
        Returns: Json[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_clinical_director: { Args: { _user_id: string }; Returns: boolean }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
    }
    Enums: {
      app_role: "patient" | "doctor" | "admin" | "clinical_director"
      appointment_status:
        | "scheduled"
        | "confirmed"
        | "completed"
        | "cancelled"
        | "no_show"
      doctor_feedback_type: "helpful" | "not_helpful"
      form_builder_status: "draft" | "published" | "archived"
      form_status: "pending" | "draft" | "completed"
      notification_channel: "email" | "sms"
      notification_status: "pending" | "sent" | "failed"
      notification_type:
        | "appointment_confirmation"
        | "form_reminder"
        | "appointment_reminder"
        | "cancellation"
        | "safety_alert"
      preferred_language: "pt" | "en"
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
      app_role: ["patient", "doctor", "admin", "clinical_director"],
      appointment_status: [
        "scheduled",
        "confirmed",
        "completed",
        "cancelled",
        "no_show",
      ],
      doctor_feedback_type: ["helpful", "not_helpful"],
      form_builder_status: ["draft", "published", "archived"],
      form_status: ["pending", "draft", "completed"],
      notification_channel: ["email", "sms"],
      notification_status: ["pending", "sent", "failed"],
      notification_type: [
        "appointment_confirmation",
        "form_reminder",
        "appointment_reminder",
        "cancellation",
        "safety_alert",
      ],
      preferred_language: ["pt", "en"],
    },
  },
} as const
