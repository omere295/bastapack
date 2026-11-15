-- editable_order is an internal helper for the packing functions; staff must not call it directly.
revoke execute on function public.editable_order(uuid) from authenticated;
