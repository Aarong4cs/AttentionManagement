-- Per-task colour.
--
-- Stored as a semantic NAME rather than a hex value, for two reasons: the same
-- token can render differently in light and dark without rewriting rows, and a
-- CHECK keeps the palette closed so a typo cannot produce an invisible block.
--
-- NULL means "the default", which is not the same as any particular colour: a
-- scheduled block and a trailed block render differently from each other by
-- default, and colour must not flatten that distinction.

alter table public.tasks
  add column color text
  check (color is null or color in ('slate', 'blue', 'violet', 'teal', 'amber', 'rose'));

-- Recurrences carry it too, so every occurrence they generate inherits it
-- instead of each one having to be coloured by hand.
alter table public.recurrences
  add column color text
  check (color is null or color in ('slate', 'blue', 'violet', 'teal', 'amber', 'rose'));
