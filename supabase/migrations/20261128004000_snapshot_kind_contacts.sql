-- School contact persons (HubSpot contacts associated with school deals) arrive as snapshot "contacts".
alter table public.snapshots drop constraint snapshots_kind_check;
alter table public.snapshots add constraint snapshots_kind_check check (kind in ('kurse','probe','schulen','deals','contacts'));
