import { Text, Card } from 'theme-ui'
import PropTypes from 'prop-types'

const stripIdFromTopic = (topic) => {
  if (!topic) return topic
  // Remove patterns like "zid-123 " or "123 - " or "123: " or "ID: xxx " from the beginning
  return topic
    .replace(/^(zid-\d+\s*[-:]?\s*|\d+\s*[-:]?\s*|ID:\s*[a-zA-Z0-9]+\s*)/, '')
    .replace(/^ID:\s*/, '') // Remove any remaining "ID: " prefix
    .trim()
}

function Conversation({ c, i, goToConversation }) {
  return (
    <Card
      onClick={goToConversation}
      sx={{ cursor: 'pointer', overflowWrap: 'break-word', mb: [3] }}
      key={i}>
      <Text as="span" sx={{ fontWeight: 700, mb: [2] }}>
        {stripIdFromTopic(c.topic)}
      </Text>
      {c.description && <Text as="span"> {c.description}</Text>}
      {c.parent_url && (
        <Text as="span" data-testid="embed-page">
          {' '}
          {`Embedded on ${c.parent_url}`}
        </Text>
      )}
      <Text as="span" sx={{ ml: [2], color: 'textSecondary', fontSize: [1] }}>
        {' '}
        {c.participant_count} participants
      </Text>
    </Card>
  )
}

Conversation.propTypes = {
  c: PropTypes.shape({
    topic: PropTypes.string,
    description: PropTypes.string,
    parent_url: PropTypes.string,
    participant_count: PropTypes.number
  }),
  i: PropTypes.number.isRequired,
  goToConversation: PropTypes.func.isRequired
}

export default Conversation
