import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import '@neo4j-ndl/base/lib/neo4j-ds-styles.css';

import ThemeWrapper from './context/ThemeWrapper';

import ChatbotDemo from './templates/shared/components/ChatbotDemo';

function App() {
  const [activeTab, setActiveTab] = useState<string>('Home');
  return (
    <BrowserRouter>
      <ThemeWrapper>
        <Routes>
          <Route path='/' element={<ChatbotDemo />} />
        </Routes>
      </ThemeWrapper>
    </BrowserRouter>
  );
}

export default App;
