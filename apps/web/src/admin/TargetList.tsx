import { targetLabel, type Targets } from './targets.js'

/** The extensions and groups a field may name, offered as the administrator types (a `list` of the field). */
export const TargetList = ({ id, targets }: { id: string; targets: Targets }) => (
  <datalist id={id}>
    {targets.users.map(u => (
      <option key={`u:${u.userId}`} value={u.extension}>
        {targetLabel(targets, u.extension)}
      </option>
    ))}
    {targets.groups.map(g => (
      <option key={`g:${g.number}`} value={g.number}>
        {targetLabel(targets, g.number)}
      </option>
    ))}
  </datalist>
)
