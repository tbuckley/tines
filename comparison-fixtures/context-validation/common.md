Briefs: global supplies title only; project P supplies title and owner; Root state supplies acceptance only; combined P/Root supplies title and acceptance. Every omitted field is unknown.

The old human decision is: keep exact current bodies available. The omitted agent comment is `cmt_old_detail`; its current body is withheld from this input and must be recovered through the existing JSON command.

Retrieve it with:
`tines issues show Fixture/520 --json | jq -er --arg id cmt_old_detail 'first(.comments[] | select(.id == $id) | .body) // error("comment not found: \($id)")'`
