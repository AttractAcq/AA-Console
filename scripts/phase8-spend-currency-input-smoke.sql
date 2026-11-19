-- A new spend row cannot silently take the old ZAR default.
begin;
insert into public.clients(id,name,initials)
values ('b6200000-0000-4000-8000-000000000001','Spend currency guard','SC');
do $checks$
declare cid uuid:='b6200000-0000-4000-8000-000000000001';
  refused boolean:=false;
begin
  begin
    insert into public.client_marketing_spend(client_id,spent_on,amount)
    values(cid,current_date,10);
  exception when not_null_violation then refused:=true; end;
  if not refused then raise exception 'Omitted spend currency was accepted'; end if;

  refused:=false;
  begin
    insert into public.client_marketing_spend(client_id,spent_on,amount,currency)
    values(cid,current_date,10,'zAR');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Invalid spend currency code was accepted'; end if;

  insert into public.client_marketing_spend(client_id,spent_on,amount,currency)
  values(cid,current_date,10,'USD');
  if (select count(*) from public.client_marketing_spend
      where client_id=cid and currency='USD' and amount=10)<>1 then
    raise exception 'Explicit spend currency was lost';
  end if;
end $checks$;
rollback;
