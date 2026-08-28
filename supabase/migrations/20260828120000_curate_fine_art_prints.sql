begin;

with mapped(id, num, status) as (
  values
    ('fap001', '01', 'active'),
    ('fap002', '02', 'active'),
    ('fap003', '03', 'active'),
    ('fap006', '04', 'active'),
    ('fap007', '05', 'active'),
    ('fap010', '06', 'active'),
    ('fap012', '07', 'active'),
    ('fap014', '08', 'active'),
    ('fap016', '09', 'active'),
    ('fap011', '10', 'active'),
    ('fap018', '11', 'active'),
    ('fap036', '12', 'active'),
    ('fap041', '13', 'active'),
    ('fap005', '14', 'active'),
    ('fap023', '15', 'active'),
    ('fap026', '16', 'active'),
    ('fap038', '17', 'active'),
    ('fap039', '18', 'active'),
    ('fap024', '19', 'active'),
    ('fap027', '20', 'active'),
    ('fap030', '21', 'active'),
    ('fap031', '22', 'active'),
    ('fap032', '23', 'active'),
    ('fap004', '24', 'active'),
    ('fap008', '25', 'active'),
    ('fap025', '26', 'active'),
    ('fap033', '27', 'active'),
    ('fap019', '28', 'active'),
    ('fap020', '29', 'active'),
    ('fap021', '30', 'active'),
    ('fap034', '31', 'active'),
    ('fap015', '32', 'active'),
    ('fap028', '33', 'active'),
    ('fap035', '34', 'active'),
    ('fap040', '35', 'active'),
    ('fap009', '36', 'active'),
    ('fap013', '37', 'active'),
    ('fap017', '38', 'active'),
    ('fap022', '39', 'active'),
    ('fap029', '029', 'archived'),
    ('fap037', '037', 'archived')
)
update products as p
set num = mapped.num,
    status = mapped.status,
    updated_at = now()
from mapped
where p.id = mapped.id
  and p.type = 'print';

do $$
declare
  active_count integer;
  active_number_count integer;
  missing_count integer;
begin
  select count(*), count(distinct num)
  into active_count, active_number_count
  from products
  where type = 'print' and status = 'active';

  if active_count <> 39 or active_number_count <> 39 then
    raise exception 'print curation expected 39 active rows and 39 unique numbers, got % and %',
      active_count, active_number_count;
  end if;

  if (select min(num) from products where type = 'print' and status = 'active') <> '01'
     or (select max(num) from products where type = 'print' and status = 'active') <> '39' then
    raise exception 'print curation expected active number range 01..39';
  end if;

  if exists (
    select 1 from products
    where id in ('fap029', 'fap037') and status <> 'archived'
  ) then
    raise exception 'fap029 and fap037 must be archived';
  end if;

  select count(*) into missing_count
  from unnest(array[
    'fap001','fap002','fap003','fap004','fap005','fap006','fap007','fap008','fap009',
    'fap010','fap011','fap012','fap013','fap014','fap015','fap016','fap017','fap018','fap019',
    'fap020','fap021','fap022','fap023','fap024','fap025','fap026','fap027','fap028','fap029',
    'fap030','fap031','fap032','fap033','fap034','fap035','fap036','fap037','fap038','fap039',
    'fap040','fap041'
  ]::text[]) as expected(id)
  left join products p on p.id = expected.id and p.type = 'print'
  where p.id is null;

  if missing_count <> 0 then
    raise exception 'print curation is missing % mapped product rows', missing_count;
  end if;
end
$$;

commit;
