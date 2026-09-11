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
      google_calendars: {
        Row: {
          calendar_id: string
          created_at: string
          enabled: boolean
          last_synced_at: string | null
          summary: string
          sync_token: string | null
          updated_at: string
          user_id: string
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          calendar_id: string
          created_at?: string
          enabled?: boolean
          last_synced_at?: string | null
          summary: string
          sync_token?: string | null
          updated_at?: string
          user_id?: string
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          calendar_id?: string
          created_at?: string
          enabled?: boolean
          last_synced_at?: string | null
          summary?: string
          sync_token?: string | null
          updated_at?: string
          user_id?: string
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: []
      }
      google_connections: {
        Row: {
          app_calendar_id: string | null
          connected_at: string
          google_email: string | null
          push_enabled: boolean
          refresh_token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_calendar_id?: string | null
          connected_at?: string
          google_email?: string | null
          push_enabled?: boolean
          refresh_token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_calendar_id?: string | null
          connected_at?: string
          google_email?: string | null
          push_enabled?: boolean
          refresh_token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      recurrences: {
        Row: {
          color: string | null
          created_at: string
          deleted_at: string | null
          dtstart: string
          estimated_minutes: number | null
          id: string
          materialized_until: string | null
          notes: string | null
          rrule: string
          time_of_day: string | null
          timezone: string
          title: string
          until: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          deleted_at?: string | null
          dtstart: string
          estimated_minutes?: number | null
          id?: string
          materialized_until?: string | null
          notes?: string | null
          rrule: string
          time_of_day?: string | null
          timezone: string
          title: string
          until?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          deleted_at?: string | null
          dtstart?: string
          estimated_minutes?: number | null
          id?: string
          materialized_until?: string | null
          notes?: string | null
          rrule?: string
          time_of_day?: string | null
          timezone?: string
          title?: string
          until?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          color: string | null
          completed_at: string | null
          created_at: string
          deleted_at: string | null
          detached: boolean
          due_at: string | null
          estimated_minutes: number | null
          external_calendar: string | null
          external_etag: string | null
          external_id: string | null
          google_event_id: string | null
          google_synced_at: string | null
          id: string
          notes: string | null
          occurrence_date: string | null
          priority: number | null
          rank: string
          recurrence_id: string | null
          scheduled_end: string | null
          source: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          completed_at?: string | null
          created_at?: string
          deleted_at?: string | null
          detached?: boolean
          due_at?: string | null
          estimated_minutes?: number | null
          external_calendar?: string | null
          external_etag?: string | null
          external_id?: string | null
          google_event_id?: string | null
          google_synced_at?: string | null
          id?: string
          notes?: string | null
          occurrence_date?: string | null
          priority?: number | null
          rank: string
          recurrence_id?: string | null
          scheduled_end?: string | null
          source?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          color?: string | null
          completed_at?: string | null
          created_at?: string
          deleted_at?: string | null
          detached?: boolean
          due_at?: string | null
          estimated_minutes?: number | null
          external_calendar?: string | null
          external_etag?: string | null
          external_id?: string | null
          google_event_id?: string | null
          google_synced_at?: string | null
          id?: string
          notes?: string | null
          occurrence_date?: string | null
          priority?: number | null
          rank?: string
          recurrence_id?: string | null
          scheduled_end?: string | null
          source?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_recurrence_id_fkey"
            columns: ["recurrence_id"]
            isOneToOne: false
            referencedRelation: "recurrences"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          created_at: string
          deleted_at: string | null
          duration_seconds: number | null
          edited_at: string | null
          ended_at: string | null
          google_event_id: string | null
          google_synced_at: string | null
          id: string
          started_at: string
          task_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          duration_seconds?: number | null
          edited_at?: string | null
          ended_at?: string | null
          google_event_id?: string | null
          google_synced_at?: string | null
          id?: string
          started_at: string
          task_id: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          duration_seconds?: number | null
          edited_at?: string | null
          ended_at?: string | null
          google_event_id?: string | null
          google_synced_at?: string | null
          id?: string
          started_at?: string
          task_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      day_start: { Args: { p_day: string; p_tz: string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
