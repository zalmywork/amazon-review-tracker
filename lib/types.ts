export interface AsinRow {
  asin: string;
  skus: string[];
  listed: boolean;
  listing_status: string | null;
  title: string | null;
  brand: string | null;
  image_url: string | null;
  variation_label: string | null;
  item_classification: string | null;
  is_parent: boolean;
  parent_asin: string | null;
  child_asins: string[];
  variation_theme: string | null;
  ever_in_family: boolean;
  catalog_found: boolean | null;
  catalog_checked_on: string | null;
  rating_count: number | null;
  rating: number | null;
  own_review_count: number | null;
  keepa_parent_asin: string | null;
  keepa_rating_at: string | null;
  keepa_checked_on: string | null;
  keepa_priority: boolean;
}

/**
 * left_family    child no longer belongs to its parent (Amazon catalog)
 * moved_family   child now sits under a different parent
 * joined_family  child is back under a parent after having been split off
 * ratings_drop   ratings shown on the listing fell sharply (Keepa)
 * history_*      the same, found in Keepa's history on the first check — i.e. before tracking began
 */
export type EventType =
  | "left_family"
  | "moved_family"
  | "joined_family"
  | "ratings_drop"
  | "history_parent_change"
  | "history_ratings_drop";

export interface EventDetails {
  old_parent?: string | null;
  new_parent?: string | null;
  source?: "child" | "parent";
  family_dissolved?: boolean;
  child_missing?: boolean;
  before?: number;
  after?: number;
  rating_before?: number | null;
  rating_after?: number | null;
  own_reviews?: number | null;
  changed_at?: string | null;
  keepa_as_of?: string | null;
}

export interface EventRow {
  id?: number;
  detected_at?: string;
  detected_on: string;
  type: EventType;
  asin: string;
  family_asin: string | null;
  details: EventDetails;
  emailed_at?: string | null;
}
